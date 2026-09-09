// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { AuthFrame, Button, FieldLabel, Input } from "@schrodump/web";

export function SignIn() {
  return (
    <AuthFrame title="Sign in" intro="Verified logical database backups" footer="Schrodump · self-hosted">
      <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" type="email" autoComplete="username" defaultValue="ops@ipog.edu.br" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" type="password" autoComplete="current-password" defaultValue="correct horse battery" />
        </div>
        <Button variant="primary" className="w-full">
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}
