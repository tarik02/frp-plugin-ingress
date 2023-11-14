# frp-plugin-ingress

## Description

frp-plugin-ingress is a plugin for [frp](https://github.com/fatedier/frp) that simplifies the management of Kubernetes Ingress objects for HTTP proxy servers. It streamlines the process of creating and managing Ingress resources, making it easier to integrate frp with Kubernetes.

## Installation

### Helm Chart

We provide a Helm chart to facilitate the installation of frp-plugin-ingress. You can find the Helm chart in the [charts/frp-plugin-ingress](https://github.com/tarik02/frp-plugin-ingress/tree/master/charts/frp-plugin-ingress) directory.

To install the chart, you can use the following command:

```bash
helm repo add frp-plugin-ingress https://tarik02.github.io/frp-plugin-ingress/

helm install frp-plugin-ingress/frp-plugin-ingress frp-plugin-ingress -f values.yaml
```

### Manual Installation

Alternatively, you can manually add the container's plugin to frp pod but detailed instruction is out of scope of this README.


## Usage

Once the frp-plugin-ingress is installed, you can add it is as a plugin to the frp server. Update your frp server configuration file to include the following section:

```toml
[[httpPlugins]]
name = "ingress"
addr = "frp-plugin-ingress:7001"
path = "/"
ops = ["NewProxy", "CloseProxy"]
```

Make sure to replace the `addr` value with the correct address where the frp-plugin-ingress is running.

## License

This project is licensed under the [MIT License](LICENSE). Feel free to use, modify, and distribute it according to the terms specified in the license.

## Contributions

Contributions are welcome! If you have any ideas, bug reports, or feature requests, please open an issue or submit a pull request.

---
Feel free to customize this template further based on additional details or specific instructions for your project.
