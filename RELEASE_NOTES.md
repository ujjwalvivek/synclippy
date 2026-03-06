# v1.0.1

### Security & Dependency Updates
- Upgraded Go runtime from `1.23` → `1.26`, resolving all known CVEs in `golang/stdlib`
- Upgraded base image from `alpine:3.20` → `alpine:3.21`, resolving `busybox` CVEs
- Fixed Docker multi-platform ARM64 build crash (QEMU `npm ci` illegal instruction)
- Fixed `ignoreDeprecations` TypeScript config error for TS 5.9+

For the initial stable release, see [v1.0.0](https://github.com/ujjwalvivek/synclippy/releases/tag/v1.0.0).

Read more about the project in the [README](README.md) and the API in [API.md](docs/API.md).
