# Check in CI

The same engine runs as a CLI with Node 18 or newer. It needs no install and no network beyond fetching the package.

```sh
npx -y github:theluckystrike/context-drift
```

In GitHub Actions, add `--format github` to get annotations on the pull request:

```yaml
- run: npx -y github:theluckystrike/context-drift --format github
```

It exits with code 1 when it finds an error. Use `--fail-on warning` to be stricter, or `--fail-on never` to only report.
