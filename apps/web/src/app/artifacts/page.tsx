// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { permanentRedirect } from "next/navigation";

// The catalog is the home screen: the product's first question is how many backups nobody has
// checked, and that is the catalog's header. The old address keeps working for bookmarks.
export default function ArtifactsPage() {
  permanentRedirect("/");
}
