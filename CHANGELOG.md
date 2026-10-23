# Changelog

## 0.2.0 Preview

- Frontend manifest and entrypoint now live at repository root for SillyTavern Git extension installation.
- Added shared Node installer with shell and PowerShell wrappers, explicit root confirmation, dry-run, integrity/version checks, scoped config opt-in, atomic journal, backups, rollback and uninstall.
- Installer fixtures cover failure recovery, symlinks, later edits, source overlap, path spaces and Unicode. No live SillyTavern install or account inference is part of the tests.
- License selection remains with the author; this repository does not grant an open-source license.

## 0.1.0 Preview

- Fixed-domain Go adapter for Chat, Responses and Messages, streaming/nonstreaming, tools, images, thinking metadata, cancellation and errors.
- Memory-only per-user credential sessions and narrow frontend routing with automatic connection recovery.
