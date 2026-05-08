# Upgrading across Paper major versions

Paper's API isn't fully stable across Minecraft major versions. Going from 1.20 to 1.21 usually requires code changes. Going from 1.16 to 1.21 definitely does. This recipe shows how pluggy makes the transition as mechanical as possible.

## The version string

`compatibility.versions[0]` drives every Paper-related resolution:

- The Maven coordinate for `paper-api` (`<version>-R0.1-SNAPSHOT` or
  `<version>.build.<N>-alpha`, depending on MC version).
- The server jar for `pluggy dev`.
- The `api-version` field in `plugin.yml`.
- The JDK picker for the IntelliJ integration.

pluggy uses that one string to wire up everything else.

## The upgrade

1. Edit `compatibility.versions[0]` in `project.json`:

   ```json
   "compatibility": {
     "versions": ["1.21.8"],
     "platforms": ["paper"]
   }
   ```

   Moving from `"1.20.6"` to `"1.21.8"` is the only change in the
   config.

2. Run a build to see what breaks:

   ```bash
   pluggy build --clean
   ```

   `--clean` wipes the staging directory so stale class files from the old Minecraft version don't mask failures.

3. Let `javac` tell you what's deprecated or removed:

   ```text
   ✖ my_plugin: compile: javac exited with code 1 for project "my_plugin" (last 40 lines):
   src/com/example/Main.java:24: error: cannot find symbol
       event.getPlayer().getLocation().getBlock().getState().getData();
                                                              ^
     symbol:   method getData()
     location: class BlockState
   ```

4. Fix the compile errors. Refer to Paper's [release notes](https://papermc.io/software/paper)
   for the breaking changes in the major you're jumping over.

5. If you also need a newer JDK for the new Paper version, install it and update `PATH`. `pluggy doctor` reports the detected JDK:

   ```text
   ✔ Java toolchain: Java 21
   ```

## Migrating the `dev/` directory

Minecraft stores world data in `dev/world*`. A world saved by 1.20 will be read-write-compatible with 1.21 most of the time (Mojang does an automatic world conversion on first boot), but some upgrades are one-way.

Safe default: delete `dev/world*` when upgrading across a major.

```bash
pluggy dev --fresh-world
```

`--fresh-world` preserves `dev/` (and `plugins/`, `server.properties`,
etc.) but deletes every `dev/world*` subdirectory. Next run starts a
fresh world at the new version.

A full reset is `--clean`, which wipes `dev/` entirely. Use this when
you also want to reset `server.properties`, plugin configs, EULA file,
and the server jar hardlink.

## Runtime plugin compatibility

Your Modrinth dependencies might not support the new Minecraft version. `pluggy info <slug>` shows compat hints against your project:

```text
$ pluggy info worldedit
WorldEdit  (worldedit)
...

versions:
  7.3.15  release  2025-08-04T10:15:00Z  [ok]
  7.3.14  release  2025-07-02T12:00:00Z  [warn]
```

`[ok]` means the plugin declares `game_versions` that overlap with your `compatibility.versions`. `[warn]` means no overlap. The plugin may still load (Modrinth metadata isn't always complete), but test before you ship.

## Check for outdated deps before shipping

```bash
pluggy doctor
```

The `outdated` check compares every Modrinth entry in `pluggy.lock`
against the current newest stable on Modrinth:

```text
! Outdated dependencies: worldedit 7.3.14 -> 7.3.15, luckperms 5.4.110 -> 5.5.0
```

Update with:

```bash
pluggy install worldedit@7.3.15
pluggy install luckperms@5.5.0
```

Or wipe the lockfile and re-resolve everything at their current
latest-stable:

```bash
rm pluggy.lock
pluggy install
```

This puts pluggy in "resolve everything now" mode and updates every
locked version that's behind.

## A typical session

```bash
# 1. Edit project.json: compatibility.versions[0] = "1.21.8"
# 2. Clean build to surface breakage
pluggy build --clean

# 3. Fix compile errors in your editor
# 4. Update Modrinth deps as needed
pluggy list --outdated
pluggy install worldedit@7.3.15

# 5. Reset the dev world and try it
pluggy dev --fresh-world

# 6. Once happy, bump your own version
# (edit project.json: version = "2.0.0")
pluggy build
```

## See also

- [`pluggy build --clean`](../commands/build.md): forces a full rebuild.
- [`pluggy dev --fresh-world`](../commands/dev.md): resets the dev world without touching config.
- [project.json `compatibility`](../project-json.md#compatibility-required): the one string that drives the upgrade.
