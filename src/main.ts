#!/usr/bin/env node
import { KubeConfig, NetworkingV1Api } from '@kubernetes/client-node';
import fastify from 'fastify';
import z from 'zod';

const kc = new KubeConfig();
kc.loadFromDefault();

const networkingV1Api = kc.makeApiClient(NetworkingV1Api);

const env = z.object({
  FRP_INGRESS_LOG_LEVEL: z.string().default('info'),

  FRP_INGRESS_HOST: z.string().default('127.0.0.1'),
  FRP_INGRESS_PORT: z.coerce.number().default(7001),

  FRP_INGRESS_NAMESPACE: z.string().default('default'),
  FRP_INGRESS_APP_INSTANCE: z.string().default('frp-ingress'),
  
  FRP_INGRESS_SUB_DOMAIN_HOST: z.string().optional(),
  FRP_INGRESS_SUB_DOMAIN_SECRET_NAME: z.string().optional(),

  FRP_INGRESS_ALLOW_CUSTOM_DOMAINS: z.enum(['true', 'false', 'ignore']).default('ignore'),

  FRP_INGRESS_INGRESS_CLASS_NAME: z.string().optional(),
  FRP_INGRESS_INGRESS_ANNOTATIONS: z.string().default('{}').transform(str => JSON.parse(str)).pipe(z.record(z.string())),
  FRP_INGRESS_INGRESS_LABELS: z.string().default('{}').transform(str => JSON.parse(str)).pipe(z.record(z.string())),

  FRP_INGRESS_INGRESS_SERVICE_NAME: z.string(),
  FRP_INGRESS_INGRESS_SERVICE_PORT_NAME: z.string().optional(),
  FRP_INGRESS_INGRESS_SERVICE_PORT_NUMBER: z.coerce.number().optional(),
}).parse(process.env);

const config = {
  logLevel: env.FRP_INGRESS_LOG_LEVEL,

  host: env.FRP_INGRESS_HOST,
  port: env.FRP_INGRESS_PORT,

  namespace: env.FRP_INGRESS_NAMESPACE,
  appInstance: env.FRP_INGRESS_APP_INSTANCE,

  subDomain: {
    host: env.FRP_INGRESS_SUB_DOMAIN_HOST,
    secretName: env.FRP_INGRESS_SUB_DOMAIN_SECRET_NAME,
  },
  allowCustomDomains: env.FRP_INGRESS_ALLOW_CUSTOM_DOMAINS,

  ingress: {
    className: env.FRP_INGRESS_INGRESS_CLASS_NAME,
    annotations: env.FRP_INGRESS_INGRESS_ANNOTATIONS,
    labels: env.FRP_INGRESS_INGRESS_LABELS,
    service: {
      name: env.FRP_INGRESS_INGRESS_SERVICE_NAME,
      port: {
        name: env.FRP_INGRESS_INGRESS_SERVICE_PORT_NAME,
        number: env.FRP_INGRESS_INGRESS_SERVICE_PORT_NUMBER,
      },
    },
  },
};

const app = fastify({
  logger: {
    level: config.logLevel,
  },
});
const log = app.log;

const frpRequestSchema = z.union([
  z.object({
    op: z.literal('NewProxy'),
    content: z.object({
      proxy_name: z.string(),
      proxy_type: z.string(),
      subdomain: z.string().optional(),
      custom_domains: z.array(z.string()).optional(),
    }).passthrough(),
  }),
  z.object({
    op: z.literal('CloseProxy'),
    content: z.object({
      proxy_name: z.string(),
    }),
  }),
]);

app.get('/readyz', () => {
  return 'ok';
});

app.get('/healthz', () => {
  return 'ok';
});

app.post('/', async (req, res) => {
  log.trace(req.body, 'Request received');

  const parseResult = frpRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    log.warn(req.body, 'Failed to parse request');
    return {
      reject: false,
      unchange: true,
    };
  }

  const request = parseResult.data;

  switch (request.op) {
    case 'NewProxy': {
      if (request.content.proxy_type !== 'http') {
        log.debug('Request type is not http, ignoring');
        return {
          reject: false,
          unchange: true,
        };
      }

      const name = `${config.appInstance}-${request.content.proxy_name}`;
      
      const { subdomain, custom_domains = [] } = request.content;
      const hosts: string[] = [];
      let secretName: string | undefined;

      if (subdomain !== undefined) {
        if (config.subDomain.host === undefined) {
          return {
            reject: true,
            reject_reason: 'subdomain is not configured',
          };
        }
        hosts.push(`${subdomain}.${config.subDomain.host}`);
        secretName = config.subDomain.secretName;
      } else {
        const allAreSubdomains = config.subDomain.host !== undefined && custom_domains.every(cd => cd.match(/^\w+\.(.*)$/)?.[1] === config.subDomain.host);
        
        if (allAreSubdomains) {
          secretName = config.subDomain.secretName;
        } else {
          if (config.allowCustomDomains === 'ignore') {
            log.debug(`Received custom domains ${custom_domains.map(cd => `"${cd}"`).join(', ')}, ignoring`);
            return {
              reject: false,
              unchange: true,
            };
          }

          if (config.allowCustomDomains === 'false') {
            return {
              reject: true,
              reject_reason: 'custom domains are rejected',
            };
          }
        }

        hosts.push(...custom_domains);
      }

      const ingressBody = {
        kind: 'Ingress',
        metadata: {
          name,
          annotations: {
            ...config.ingress.annotations,
            'app.kubernetes.io/managed-by': config.appInstance,
            'frp-ingress.io/ingress-instance': config.appInstance,
            'frp-ingress.io/proxy-name': request.content.proxy_name,
            'frp-ingress.io/proxy-spec': JSON.stringify(request.content),
          },
          labels: {
            ...config.ingress.labels,
          },
        },
        spec: {
          ingressClassName: config.ingress.className,
          rules: hosts.map(host => ({
            host,
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: config.ingress.service,
                  },
                },
              ],
            },
          })),
          tls: secretName !== undefined
            ? [
              {
                hosts,
                secretName: secretName,
              },
            ]
            : hosts.map(host => ({
              hosts: [host],
              secretName: `${config.appInstance}-${host}`,
            })),
        },
      };

      log.debug({ ingressBody }, 'prepared ingress object');

      let ingressExists = false;
      try {
        const { body: ingress } = await networkingV1Api.readNamespacedIngress(name, config.namespace);
        if (ingress.metadata?.annotations?.['app.kubernetes.io/managed-by'] !== config.appInstance) {
          throw new Error(`Ingress "${name}" already exists but it is not managed by "${config.appInstance}"`);
        }
        ingressExists = true;
      } catch (e) {
        if (!(typeof e === 'object' && e !== null && 'statusCode' in e && e.statusCode === 404)) {
          throw e;
        }
      }

      const ingress = ingressExists
        ? await networkingV1Api.replaceNamespacedIngress(name, config.namespace, ingressBody)
        : await networkingV1Api.createNamespacedIngress(config.namespace, ingressBody);

      log.debug({ ingress }, 'ingress created');

      return {
        reject: false,
        unchange: true,
      };
    }

    case 'CloseProxy':
      const name = `${config.appInstance}-${request.content.proxy_name}`;

      try {
        const { body: ingress } = await networkingV1Api.readNamespacedIngress(name, config.namespace);
        if (ingress.metadata?.annotations?.['app.kubernetes.io/managed-by'] !== config.appInstance) {
          throw new Error(`Ingress "${name}" exists but it is not managed by "${config.appInstance}"`);
        }
      } catch (e) {
        if (!(typeof e === 'object' && e !== null && 'statusCode' in e && e.statusCode === 404)) {
          throw e;
        }
        return;
      }

      log.debug({ name }, 'deleting ingress');

      await networkingV1Api.deleteNamespacedIngress(name, config.namespace);
      break;
  }

  return {
    reject: false,
    unchange: true,
  };
});

app.listen({
  host: config.host,
  port: config.port,
});
