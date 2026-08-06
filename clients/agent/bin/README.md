# Prebuilt binaries

Written by CI on every push to `main`, from the commit named in the message of
the commit that placed them. Five targets, two binaries each:

```
tern-agent-x86_64-unknown-linux-musl      tern-proxy-x86_64-unknown-linux-musl
tern-agent-aarch64-unknown-linux-musl     tern-proxy-aarch64-unknown-linux-musl
tern-agent-aarch64-apple-darwin           tern-proxy-aarch64-apple-darwin
tern-agent-x86_64-apple-darwin            tern-proxy-x86_64-apple-darwin
tern-agent-x86_64-pc-windows-msvc.exe     tern-proxy-x86_64-pc-windows-msvc.exe
```

Verify before running one:

```sh
sha256sum -c SHA256SUMS
```

## What this costs

Ten binaries at roughly 7 MB each is about 70 MB per refresh, and git keeps
every version for ever — a clone gets larger with each one and never smaller.
That is the trade for having them in the tree.

Two ways out if the repository starts to hurt: keep them only on tagged
releases, where the `Release` job already publishes the same files with the same
checksums, or move this directory to Git LFS.

Do not edit anything here by hand. CI replaces the directory wholesale, because
a stale binary from a target that stopped building is exactly the kind of thing
nobody notices until they ship it.
