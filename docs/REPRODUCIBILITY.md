# Reproducibility

This is a publishable source snapshot, not a backup of private runtime state. Credentials, browser profiles, uploads, captures, saved model results, screenshots, local reports, backups and installed dependencies are absent.

Install pinned dependencies using the main README. Node22/Python3.14 on Fedora was the original tested platform; a fresh remote-host installation has not been performed during snapshot preparation. Python extraction relies on Linux resource limits.

The rootless Podman image uses a pinned official base. Named volumes copy seed assets on first creation. The lifecycle adaptation retains SQLite and snapshots in-memory collections every two seconds; it does not guarantee abrupt-power-loss recovery. Browser authentication may require ordinary login after reopening.

Azure credentials are configured locally by the owner. No private resource defaults or saved results are supplied. Analysis input coverage is bounded, not an automatic exhaustive discovery. Missing traffic stays absent until an owner records and selects it.
