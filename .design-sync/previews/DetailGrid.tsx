// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { DetailGrid } from "@schrodump/web";

export function ArtifactFacts() {
  return (
    <div className="max-w-2xl rounded-panel bg-muted px-[18px] pt-2 pb-4">
      <DetailGrid
        facts={[
          { label: "Destination", value: "Cloudflare R2" },
          { label: "Created", value: "Sep 9, 2026, 3:46 PM" },
          { label: "Last verified", value: "2 hours ago", tone: "verified" },
          { label: "Bucket key", value: "org/ipog-nexus/2026-09-09T18-46-12.archive" },
          { label: "Checksum", value: "sha256 · 9f3c…e1a0" },
          { label: "Restore verified", value: null },
        ]}
      />
    </div>
  );
}

export function Tones() {
  return (
    <div className="max-w-2xl rounded-panel bg-muted px-[18px] pt-2 pb-4">
      <DetailGrid
        facts={[
          { label: "Plain", value: "412 MB", tone: "plain" },
          { label: "Caution", value: "checksum only — full restore unavailable", tone: "caution" },
          { label: "Danger", value: "exit code 1", tone: "danger" },
          { label: "Verified", value: "by full restore", tone: "verified" },
          { label: "Unobserved", value: "nobody looked yet", tone: "unobserved" },
          { label: "Failed", value: "restored, produced no usable schema", tone: "failed" },
        ]}
      />
    </div>
  );
}
