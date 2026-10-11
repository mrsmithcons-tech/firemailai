# Validation

The packaged source passed:

- 28 Node.js tests covering API access, ownership, lock enforcement, encryption, OAuth state, Gmail token renewal, drafts, attachment limits, MIME headers, duplicate sends, and sample data.
- JavaScript syntax checks and JSON configuration parsing.
- Static UI element/asset checks, RTDB deny-rule checks, and Hosting rewrite checks.
- Importing the installed Firebase SDKs and resolving the `mailApi` function export.
- DOM interaction exercises for inbox reading, starring, compose, draft saving/reopening/sending, search, folders, forwarding, password reveal, lock/clear/unlock, draft Cc/Bcc preservation, and attachment encoding.
- Hostile-email HTML sanitization exercises, including script/event removal and blocked remote images.
- An independent Python mail parser check for Urdu subjects, multiple recipients, Bcc, reply headers, attachment contents, and long Unicode filenames.

The API tests use a local in-memory RTDB substitute and mocked Google responses. DOM exercises use a DOM simulation; visual layout and Google sign-in have not been checked in a live browser. No Firebase deployment or real Gmail account was available during creation. No real mail was sent.

Complete the first live connection, draft, attachment, and send checks described in SETUP.md after configuring your project.
