# UNO-Q Development System
## Hybrid RobotiX

A portable, repeatable development environment for the Arduino UNO Q, built around versioned bin commands, a single bootstrap script, and a clean separation of configuration from logic.

---

## Quick Start

For a new UNO Q, copy the bootstrap script to `$HOME` and run it once:

```bash
cp scripts/newrepo.bash ~/newrepo.bash
# Edit the top variables to match your setup
bash ~/newrepo.bash
```

After the first `start`, `~/bin/newrepo` is installed automatically and you can use `newrepo` directly from then on.

---

## Repository Structure

```
UNO-Q-Development-System/
  bin/          — Versioned Python bin commands
  scripts/      — Bootstrap script (newrepo.bash template)
  docs/         — Design documents, inventory, known issues
  README.md     — This file
```

---

## Configuration

Only the top variables in `scripts/newrepo.bash` need editing for a new user:

```bash
REPO_DEST="$HOME/Repos/GitHub/hybotix/UNO-Q"  # Local clone path
REPO="https://github.com/hybotix/UNO-Q.git"    # Robot app repo URL
SECRETS_DEST="securesmars"                       # Apps needing secrets.py
COMMANDS="addlib build clean list logs restart start stop"  # Bin commands
```

Everything below the variables is generic infrastructure — no changes needed.

---

## Bin Commands

| Command | Description |
|---------|-------------|
| `start <app>` | Nuke Docker, clear cache, install newrepo, mount $HOME, start app |
| `restart <app>` | Delegates to start |
| `stop` | Stop the running app |
| `logs` | Show live app logs |
| `list` | List available apps |
| `build <app>` | Compile and flash sketch |
| `clean` | Full Docker nuke + cache clear + restart |
| `addlib` | Search, install, list, or upgrade Arduino libraries |

---

## Conventions

- All Python, no bash/shell scripts
- Versioned filenames: `command-vX.Y.Z.py`
- Configuration in variables at top of each script
- `newrepo.bash` lives in `$HOME` only — never in the repo
- `start` installs `~/bin/newrepo` on every run

---

## Related Repositories

- **[UNO-Q](https://github.com/hybotix/UNO-Q)** — Robot apps (Arduino sketches + Python controllers)

---

## License

See LICENSE file.
