# Isolated paper compiler

Paper builds use a separately installed, digest-pinned Linux container image. The application never executes TeX on the API host, downloads packages during a build, or sends source to a remote compiler. The supported runtime is a local Docker Unix socket with Linux memory, swap, CPU, process and seccomp enforcement. A local Linux VM provides that runtime on macOS; its setup belongs to the operator.

## Prepare the toolchain

Python 3.11 or newer and Docker are needed to prepare the image. This preparation downloads public compiler and package distributions only. It does not compile submitted papers.

```sh
python3 worker/tex/prepare.py --directory .data/tex-toolchain --discard-downloads
docker build \
  --build-arg BUNDLE_SHA256=b99f6292ac4ac5ef74566f7ba044491adbf67096f4b020855a6de0ad192d32f8 \
  --tag phabricator-tex:local \
  .data/tex-toolchain/image
docker image inspect phabricator-tex:local --format '{{.Id}}'
```

The preparation script verifies both the public Tectonic 0.17.0 release archive and the complete `tlextras-2022.0r0` support archive. It converts all 134,980 support files to a compressed local ZIP with a fixed SHA-256. Full bundle reconstruction has produced identical bytes with zlib 1.2.12, 1.2.13 and 1.3; preparation fails explicitly if another compressor produces different bytes. Partial conversions are temporary files and can be retried. This is a large, complete offline bundle, not a cache of packages used by the test fixture. Its compressed ZIP is about 1.4 GiB. Allow additional space for the 2.8 GB download and container build layers; `--discard-downloads` removes only the verified redundant support archive after ZIP verification. The Dockerfile pins its Alpine base by digest and its PDF metadata utility version. Third-party compiler, font and package licenses continue to apply; the support bundle stays outside this repository.

The final image ID pins the complete installed toolchain, including dependencies. Keep that image available locally. Builds use `--pull=never`; a missing image fails explicitly. Preparing a replacement image produces a new toolchain identity; queued builds do not silently move to it.

Configure the application with the exact image ID printed above and the path to the local Docker socket:

```dotenv
PHABRICATOR_TEX_IMAGE=sha256:<64 lowercase hexadecimal characters>
PHABRICATOR_TEX_DOCKER_SOCKET=/var/run/docker.sock
PHABRICATOR_TEX_WORK_DIR=.data/tex-worker
```

The work directory must be visible at the same path to a local VM's Docker daemon. It must not contain symbolic links. Only a per-build source subdirectory is mounted into the container, read-only. Do not configure a remote daemon or expose its socket to the compiler. The application requires operator access to the daemon, which is a privileged interface; dedicate the runtime to this service or use an appropriately configured rootless daemon.

## Fixed execution policy

The current policy is `tex-container-v1`. The application verifies image labels against the expected engine, bundle digest and policy before every build. Document-supplied `Tectonic.toml`, shell commands, build scripts, engine switches and URLs are not executed as configuration.

Each run has no network, no capabilities, no privilege escalation, a read-only root filesystem, UID/GID 65534, Docker's seccomp policy, a maximum of 32 processes, one CPU, 768 MiB memory with no additional swap, and a 128 MiB `noexec,nosuid,nodev` temporary filesystem. There is no writable host mount. A 16 MiB per-file limit and a 24 MiB transport limit bound output. The engine has a 60-second deadline inside the container, PDF inspection has a five-second deadline, and the parent imposes an additional 75-second deadline. The inner deadlines still apply if the API worker exits. Cancellation kills and removes the named container; temporary source directories are deleted in a final cleanup step.

The fixed invocation uses Tectonic's `--untrusted`, `--only-cached`, `--bundle`, `--synctex` and `--keep-logs` options. It uses `/source` and `/work` paths with `SOURCE_DATE_EPOCH=946684800`, and fixes every source file and directory timestamp to that epoch, including the values seen by `\filemoddate`. It avoids the `deterministic-mode` option that breaks SyncTeX paths. The prewarmed format cache and fixed font configuration stay read-only in the image. Tectonic performs the necessary TeX and BibTeX passes. This engine does not provide arbitrary native executables such as shell-escape tools or Biber.

## Output and source navigation

Successful runs publish a PDF, bounded compiler log, original compressed SyncTeX, a validated source mapping, and a deterministic manifest. Consecutive `note: Writing` progress messages are sorted because Tectonic reports saved files in hash-map order; other log lines retain their original order. The manifest names the immutable revision/version/content digest, entrypoint, toolchain, every source file digest and length, and every other artifact digest and length. It contains no wall-clock timestamp or mutable source reference.

The mapping uses PDF points from the top-left of each page. It includes only paths and valid line numbers present in that exact source snapshot. Coordinates and page dimensions must be finite and bounded; compressed SyncTeX is limited to 16 MiB after decompression. At most 1,000 pages and 100,000 source positions are published. The first implementation rejects PDF rotation, non-default page crops and nonstandard UserUnit values instead of displaying incorrect source targets. Landscape pages with their actual width and height remain supported. Source positions describe TeX layout nodes, so a source line may map to several boxes; they are navigation aids rather than semantic sentence annotations.

The current source model contains UTF-8 files. It supports multi-file TeX and BibTeX text, but does not yet provide immutable binary figure/font assets or arbitrary external tools. Those remain explicit parity gaps.

## Verify a real runtime

Ordinary tests exercise validation and hostile output parsing without requiring Docker. The integration tests must be run against the actual prepared image before changing this policy:

```sh
PHABRICATOR_TEX_INTEGRATION=1 node --import tsx --test server/tex-runner.test.ts
```

The environment variables above must also be set. `PHABRICATOR_TEX_FIXTURE_DIR` optionally saves the real test PDF, source files, SyncTeX, map and manifest into an operator-selected local directory for visual inspection. Integration tests cover nested source files, bibliography, identical rebuilt PDF/map/manifest bytes, mapped compiler errors, host-path isolation, unavailable packages, disabled shell escape, cancellation, the inner deadline for an uncanceled infinite expansion, observed container confinement, and output flooding.

The implementation follows the upstream [Tectonic compile interface](https://tectonic-typesetting.github.io/book/latest/v2cli/compile.html), [support-bundle distribution](https://github.com/tectonic-typesetting/tectonic-relay-service/blob/main/temporary_redirects.map), and [Docker runtime isolation controls](https://docs.docker.com/engine/containers/run/).
