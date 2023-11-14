####################################################################################################
# base
####################################################################################################

FROM docker.io/library/node:20 AS base

####################################################################################################
# build
####################################################################################################

FROM base AS build

WORKDIR /app

RUN corepack enable yarn

COPY package.json yarn.lock .yarnrc.yml .
COPY .yarn .yarn

RUN yarn install --immutable

COPY . .

RUN yarn pack


####################################################################################################
# runtime
####################################################################################################

FROM base AS runtime

COPY --from=build /app/package.tgz /package.tgz
RUN yarn global add /package.tgz && rm /package.tgz

ENTRYPOINT "frp-plugin-ingress"
