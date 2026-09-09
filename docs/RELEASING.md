# GitHub publication and source releases

Publish **this directory as the repository root**, or use the extracted source ZIP. Do not publish the parent modeling workspace. No remote repository is created by these scripts.

The repository uses npm workspaces. Packages are `private:true` to prevent accidental npm registry publication; this does not restrict GitHub source publication or Apache-2.0 reuse.

## Release procedure

```sh
npm ci
npm run build
npm test
npm run docs
npm run notices
npm run release
npm run verify
```

`release` uses an explicit source allowlist and excludes dependency installations, compiled output, workspace models, checkpoints, source PSDs and test reports. It updates `DISTRIBUTION-MANIFEST.json` and writes `releases/StandRig-0.2.0-source.zip` with its SHA256 file. Text files are packaged and hashed with LF line endings; `verify` applies the manifest's same normalization so Windows checkout line endings do not create false failures. Binary data and the ZIP checksum are exact byte hashes. The ZIP requires `npm ci` and `npm run build` after extraction; it is not a precompiled executable.

Verify the ZIP in a new folder, including a path with spaces, using the same install/build/test/verify commands. Keep the release report separate from private data. The manifest verifies release source hashes, not user-created model files. After source edits, regenerate the manifest as part of the next release.

For GitHub, create a repository from the extracted source folder, check the file list, then push using the owner's selected account and repository name. Include LICENSE, NOTICE, THIRD_PARTY_NOTICES.md and licenses/. Do not add workspace/, reports/, personal PSDs, credentials or generated character art. Configure repository details and security reporting contact before opening contribution channels. Attach the reviewed source ZIP and checksum to a release after validation.

## Continuous integration

`.github/workflows/ci.yml` builds/tests on Windows and Ubuntu with Node 22 and 24. It has read-only repository permissions and does not publish artifacts or packages. Configuration is included; remote CI is not considered passed until it has actually run on GitHub.

## License and provenance

Original StandRig code, docs and geometric demo are Apache-2.0 by the owner's selection. Attribution currently uses the project name “StandRig contributors”; a publisher can add their preferred author attribution without changing third-party notices. PSD/artwork ownership is separate. `SOURCE-PROVENANCE.json` preserves the historical extraction hashes from 0.1.0 and records the 0.2.0 reorganization; the current release manifest is authoritative for current source bytes.

The repository is a development release. No user webcam, OBS capture, real-character maximum-pose review, Cubism compatibility or Linux execution is claimed by a local Windows build/test result.
