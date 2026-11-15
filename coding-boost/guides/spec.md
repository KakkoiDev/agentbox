---
triggers: must, raise, raises, invalid, only, never, unknown, reject, rejects, validate, validation
---
A request with rules: before finishing, list every rule in the request and make sure a test checks each one,
including every error case. For a value that must have a type or range, test the near misses too: values of
related types that may pass a loose check, zero, negative, empty and the boundary itself. When an error must
leave state unchanged, do every check before changing anything.
