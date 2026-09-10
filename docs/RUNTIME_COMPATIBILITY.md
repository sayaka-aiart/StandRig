# Runtime compatibility policy

Status: decided for the next public release; enforcement is not implemented yet.

This policy replaces the exploratory compatibility notes in ARCHITECTURE.md. The project has not been promoted yet, but its GitHub history is already public: existing unversioned files must remain recoverable. Production-character E2E has been completed according to the project owner; this decision does not reopen that completed work.

## 1. Initial public baseline

The corrected evaluator is runtime compatibility **1**. The reversed negative-target Blend Shape calculation is a pre-baseline defect, not a supported legacy mode. Do not ship an option that reenables that defect. The initial compatibility fixtures must pin the baseline evaluator commit and numerical/visual evidence before release; the compatibility field alone is not that evidence.

There will be no compatibility 0 evaluator. Missing compatibility metadata means **unversioned**, not 0, 1 or “latest”. Never infer it from filenames, modification times, application versions or the presence/absence of negative shapes.

Target the next promoted release as **StandRig 0.3.0**, after the implementation and release gates below pass. Do not retag or replace previously published source history. Do not claim that today's 0.2.0 runtime enforces this policy.

## 2. Three separate versions

The intended model header is:

```json
{
  "schemaVersion": "0.2.0",
  "runtimeCompatibility": 1,
  "name": "Example model"
}
```

This is a header excerpt, not a complete importable model.

- Application/package version (`0.3.0`): shipped software release.
- Rig `schemaVersion` (`0.2.0`): data-format contract. This increments because the new compatibility field is required. Existing rigs currently use `0.1.0`.
- Rig `runtimeCompatibility` (`1`): integer identifying evaluation semantics, independent of software release numbering.

Keep the outer standrig-bundle version at 1 because its envelope is unchanged; the embedded rig header is authoritative. Do not duplicate a second compatibility selector in the bundle, tracking adapter or playback session. `createdWith` may be diagnostic metadata but must not select an evaluator.

## 3. Reader and writer behavior

| Input | Required behavior |
| --- | --- |
| New PSD/sample project | Create the current schema with explicit compatibility 1 |
| Supported schema and compatibility | Validate and use its declared evaluator |
| Missing compatibility | Open only for diagnostics and explicit adoption; no normal playback or modeling commit |
| Unknown/newer compatibility | Report unsupported compatibility; never substitute the newest supported evaluator |
| Invalid field (string, fraction, zero, negative, null) | Reject as invalid metadata |
| Unsupported schema | Report unsupported format independently of compatibility |
| Export/checkpoint | Preserve the declared compatibility and include it in revision/hash calculations |
| Restore | Preserve the checkpoint's metadata; never retag on restore |

Do not prevent access to migration by crashing service startup on an unversioned workspace. Diagnostic mode must expose the source revision, compatibility status and adoption path without evaluating the model. Normal editing and playback stay disabled until adoption. Restoring an old unversioned checkpoint returns to that same diagnostic state.

Apply the contract at service import/startup/reload, embedded runtime load, browser preview/player load, public frame-evaluation entry points and bundle entry points. Direct low-level numerical helpers may have a documented validated-input precondition; ordinary users must not bypass the check by choosing a different loader. Report support information through context/health and machine-readable MCP errors. Use explicit error categories for missing, invalid and unsupported compatibility; do not silently discard an unfamiliar render-affecting channel.

A schema bump helps older strict readers reject newer files, but cannot make every already-distributed permissive reader safe. Document the minimum runtime release for the new format. Test known old readers and describe their actual behavior rather than claiming universal rejection.

## 4. One-time adoption of unversioned models

Adoption is an explicit transaction, separate from structural migration and ordinary import. Never stamp compatibility 1 inside the current migrateRigDocument function as a side effect of reading.

1. Inspect the original without mutating it; compute its revision/hash and list unversioned status plus negative-target shape owners/IDs.
2. Materialize a separate candidate with schema 0.2.0 and compatibility 1. Record the source hash and target evaluator revision. This candidate opts into the corrected calculation; it is not a promise of identical legacy appearance.
3. Run numeric checks and review the relevant poses using the candidate. For changed negative-target behavior, inspect neutral/intermediate/target and affected combinations. Existing visual evidence may be reused when it demonstrably refers to the same model and evaluator; do not rerun completed E2E merely because a header is added.
4. Commit only through the revision-checked transaction, with an explicit adoption request and recorded visual acceptance. Preserve the original in a self-contained rollback checkpoint; failed or dry-run adoption writes no active model.
5. Export the adopted model with its compatibility intact. Restoring the original unversioned model does not implicitly accept it again.

Adoption must not invert offsets, swap keys or otherwise guess a shape repair. An already-reviewed current model can be adopted without geometry edits. If an older model needs the pre-baseline appearance for comparison, retain its original data and use a pinned earlier release for that read-only comparison; do not add that old defect to the supported current evaluator.

The private production model is not automatically edited by this policy or public-repository maintenance. Its completed E2E record can become baseline evidence once its source/evaluator hashes are linked to the adoption record.

## 5. Rules after baseline 1

Keep compatibility 1 when documentation, UI, performance or API validation changes do not alter evaluation of valid compatibility-1 models. The recent Part-selector and numeric-schema changes are authoring/input-contract changes, not reasons by themselves to create a new runtime generation.

Create a new compatibility generation when a valid model's evaluation meaning changes: weight direction, binding order, transform composition, interpolation rules, deformation/Glue interpretation or physics equations. A bug-fix label does not exempt such a change. Newly supported render-affecting channels also need a format/compatibility transition so an older evaluator cannot silently ignore them. Do not bump compatibility for every ordinary software release.

Numerical and image comparisons use fixture-specific documented tolerances. Promise the declared behavior and tested tolerances, not pixel-identical output across every GPU/browser. If an optimization exceeds those tolerances, investigate it rather than silently expanding them to pass.

The mainline runtime supports the current and immediately preceding published compatibility generation. At the initial release this is only generation 1. Introducing generation 2 requires tested generation-1 evaluation or equivalent preservation within its declared tolerances. Removing an older supported generation requires a published migration path and release notice; loading unsupported data remains an explicit refusal. Do not maintain an unlimited collection of historical bug modes. Unsafe execution must not be retained solely for compatibility; provide a safe rejection/migration path where necessary.

Future upgrades follow explicit candidate -> QA/visual acceptance -> revision-checked commit -> rollback, never automatic retagging. Preserve migration provenance, including source/target compatibility and hashes. Updating the application alone must not upgrade a model.

## 6. Implementation order and release gates

1. Add the compatibility type/constants, shared validator and machine-readable support/status/error contract. Bump the rig schema for newly generated models; add metadata to PSD/sample creation and generated schemas.
2. Guard every supported loading/evaluation path, including existing-workspace diagnostic mode, bundle load and checkpoint restore. Preserve metadata through export and revision calculation.
3. Implement explicit unversioned adoption through the application transaction service and MCP, with dry-run, source revision, provenance, acceptance and rollback. No global “ignore compatibility” flag.
4. Pin compatibility-1 fixtures for negative/positive shape weights, Part/Deformer composition, ArtMesh/Warp keyforms, shared fields, Glue and physics. Test save/export/import/reload/restore and unknown/missing versions across HTTP, real MCP and embedded/browser runtime.
5. Associate the already-completed production-character E2E evidence with the relevant baseline hashes. Review any actually changed candidate poses; do not mark all existing E2E work incomplete.
6. Validate a fresh source archive, update Japanese/English onboarding and migration documentation, pass Windows/Linux CI and publish 0.3.0. Promotion should follow these gates.

This document settles the intended behavior. Until the implementation lands, runtimeCompatibility is not a supported API field and must not be manually added as if it enabled these guarantees.
