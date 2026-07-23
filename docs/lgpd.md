# LGPD and backups

Notes for operators subject to Brazil's Lei Geral de Proteção de Dados (Lei 13.709/2018). The
same reasoning applies almost unchanged under the GDPR.

**This is not legal advice.** It describes what the software does, so that whoever is accountable
can decide what it means for them.

## Who is who

Schrodump is software you run. It is not a service, and ARIERRAC receives no data from your
instance.

- **You are the controller** (*controlador*) of the personal data in your databases, and you
  remain the controller of the copies Schrodump makes.
- If you run Schrodump on behalf of a customer, you are that customer's **processor**
  (*operador*), and your DPA covers the backups like any other processing.
- Backing up is processing. The copies are personal data, with the same legal basis, the same
  retention duty and the same breach-notification duty as the originals.

## What Schrodump gives you

### Encryption per artefact (art. 46)

Every artefact is encrypted with `age` before it leaves the host, to two recipients — an
operational key and an escrow key. Keys are wrapped by a key-encryption key (`SCHRODUMP_KEK`)
that lives outside the database it protects.

For a breach assessment this is the fact that matters: an attacker who obtains your bucket
obtains ciphertext. Under art. 48 you still assess and may still have to notify, but "encrypted
artefacts, keys held elsewhere, no evidence of key compromise" is a materially different
assessment from "the dumps were readable".

Database credentials are encrypted at rest with a per-credential key and are never decrypted for
display — the interface can replace a credential, never show one.

### Retention (art. 15, art. 16)

Retention is a grandfather-father-son policy per backup policy: keep N last, N daily, N weekly, N
monthly, N yearly. Artefacts outside the policy are deleted.

Two things to get right:

- **Set retention from your legal basis, not from disk space.** Art. 16 says data is eliminated
  when processing ends, with narrow exceptions (legal obligation, study by a research body,
  transfer to a third party, anonymised use). "We kept ten years of dumps because storage is
  cheap" is not one of them.
- **Retention applies to artefacts, not to what is inside them.** Schrodump deletes whole
  artefacts. It does not, and cannot, reach into an encrypted dump to remove one person's row.

### Audit trail (art. 37)

Schrodump records who did what: backups triggered, verifications run, restores performed, targets
and destinations created or changed. Restores in particular record the operator, the artefact,
the scope and the time.

Art. 37 requires the controller to keep records of processing operations. The trail also answers
the question that follows any incident — "did anyone read the backups, and who".

### Right to information and portability (art. 18)

The artefact catalogue tells you which backups exist, of which database, at which time, and where
they are stored. That is the input to answering a data subject's access request about the copies.

## The hard part: Object Lock versus the right to elimination

This is where backups and art. 18 §V pull in opposite directions, and no tool resolves it
cleanly.

**The tension.** Immutability — S3 Object Lock, WORM storage — is the standard defence against
ransomware. An attacker who takes your infrastructure cannot delete backups that the storage
layer refuses to delete. It is also, for a defined window, an explicit refusal to delete data on
request. Two legitimate obligations, and they are opposed.

**How this is handled: the erasure happens at restore, not in the artefact.**

An artefact is an immutable point-in-time record. Modifying it to remove one subject would be
forgery — the artefact would no longer be what was backed up, and the audit trail that says it is
would be false. So the position is:

1. **Erase in the live database.** That is where the data is processed and where art. 18 §V is
   satisfied.
2. **Record the erasure request** with its date, in your own records, not in Schrodump.
3. **Let the artefact expire** under retention. It ages out on the schedule you set, which is why
   a retention window measured in months rather than years is a compliance decision and not a
   storage one.
4. **Re-apply erasures on restore.** If you restore a backup taken before an erasure request, the
   erased data comes back. Your restore runbook must include re-applying pending erasure requests
   as a step, and that is the step people forget.

Point 4 is the whole answer. A backup that is not restored harms nobody; a restore that silently
resurrects erased data is a new incident with a date of its own.

**What to tell a data subject.** The honest and defensible answer is that their data has been
removed from active systems, that backup copies are retained for a stated period under
information-security duties (art. 46) and are not used for any processing, and that they expire
on a defined schedule. ANPD has not published guidance treating backup retention as a violation
of art. 18 §V where erasure is applied to live data and backups expire on a defined, documented
schedule — but write the schedule down, because "we delete them eventually" is not one.

**If you enable Object Lock**, set the retention window to the shortest period your ransomware
threat model tolerates, document why that number, and make sure it is shorter than your stated
backup retention. A lock window longer than your retention policy means artefacts you have
promised to delete that the storage will not let you delete.

> Object Lock support is **not implemented** in v1 — see [roadmap.md](roadmap.md). What is
> written here is the position to design against, not a description of a feature that exists.

## A short checklist

- [ ] Retention set from a legal basis you can state, not from available disk.
- [ ] `SCHRODUMP_KEK` stored outside the backup host, with an offline copy.
- [ ] Restore runbook includes re-applying pending erasure requests.
- [ ] Erasure requests logged with dates, so step 4 is possible at all.
- [ ] Backups covered by the DPA if you process for someone else.
- [ ] Verification on: an unverified backup is not a security measure under art. 46, it is an
      assumption.
- [ ] If using Object Lock: window documented, and shorter than your retention policy.
