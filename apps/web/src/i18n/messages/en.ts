// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Default project locale. Every user-facing string lives here — never a literal in a component.
// {placeholders} are interpolated at render time.
export const en = {
  "app.name": "Schrodump",
  "app.tagline": "Verified logical database backups",

  "nav.dashboard": "Dashboard",
  "nav.targets": "Targets",
  "nav.destinations": "Destinations",
  "nav.policies": "Policies",
  "nav.jobs": "Jobs",
  "nav.artifacts": "Artifacts",
  "nav.settings": "Settings",
  "nav.signOut": "Sign out",

  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.create": "Create",
  "common.close": "Close",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "common.error": "Something went wrong",
  "common.errorDetail": "The request failed: {message}",
  "common.empty": "Nothing here yet",
  "common.required": "This field is required",
  "common.configured": "Configured",
  "common.replace": "Replace",
  "common.notAvailable": "Not available yet",
  "common.endpointPending": "This data needs a server endpoint that is not available yet.",

  "locale.label": "Language",
  "locale.en": "English",
  "locale.pt-BR": "Portuguese (Brazil)",

  "state.verified": "Verified",
  "state.unobserved": "Unobserved",
  "state.failed": "Failed",
  "state.unobserved.hint": "No verify has run — this backup is an open question.",

  "dashboard.title": "Dashboard",
  "dashboard.unobservedBackups": "{count} unobserved backups",
  "dashboard.unobservedHint": "Backups with no verify — the questions to answer first.",
  "dashboard.verifiedBackups": "{count} verified",
  "dashboard.failedBackups": "{count} failed",
  "dashboard.recentJobs": "Recent jobs",
  "dashboard.noJobs": "No jobs yet",

  "job.kind.BACKUP": "Backup",
  "job.kind.RESTORE": "Restore",
  "job.kind.VERIFY": "Verify",
  "job.state.PENDING": "Pending",
  "job.state.RUNNING": "Running",
  "job.state.SUCCEEDED": "Succeeded",
  "job.state.FAILED": "Failed",
  "job.state.CANCELLED": "Cancelled",

  "auth.login.title": "Sign in",
  "auth.login.email": "Email",
  "auth.login.password": "Password",
  "auth.login.submit": "Sign in",
  "auth.login.error": "Invalid email or password",

  "setup.title": "Create the first administrator",
  "setup.description": "This link is single-use and expires. Set the initial admin account.",
  "setup.token": "Setup token",
  "setup.email": "Email",
  "setup.password": "Password",
  "setup.submit": "Create admin",
  "setup.done.title": "Administrator created",
  "setup.done.description": "You can now sign in.",
  "setup.done.goToLogin": "Go to sign in",
  "setup.closed.title": "Setup is closed",
  "setup.closed.description": "An administrator already exists. Recovery is available via the CLI.",

  "engine.postgres": "PostgreSQL",
  "engine.mysql": "MySQL",
  "engine.mariadb": "MariaDB",
  "engine.mongodb": "MongoDB",

  "credential.replacePlaceholder": "Enter a new value to replace",
  "form.invalid": "Please fix the errors below",

  "targets.title": "Database targets",
  "targets.add": "Add target",
  "targets.name": "Name",
  "targets.engine": "Engine",
  "targets.host": "Host",
  "targets.port": "Port",
  "targets.username": "Username",
  "targets.password": "Password",
  "targets.tls": "Require TLS",
  "targets.testConnection": "Test connection",
  "targets.probe.ok": "Connection succeeded",
  "targets.probe.failed": "Connection failed",
  "targets.probe.version": "Detected version: {version}",
  "targets.probe.limited": "Scope, estimated size and probe warnings need a richer server endpoint.",
  "targets.empty": "No targets yet. Add one to start backing it up.",
} as const;

export type MessageKey = keyof typeof en;
