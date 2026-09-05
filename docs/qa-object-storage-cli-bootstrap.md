# Object Storage bootstrap QA

This QA branch exists only to trigger CI against the main-branch change that moves Object Storage bucket creation from the Terraform storage resource to the official `yc storage bucket` CLI flow.

Expected checks:

- bootstrap shell syntax;
- Terraform formatting/initialization/validation on Terraform 1.5.7;
- web typecheck/tests/build;
- Python compile/tests.
