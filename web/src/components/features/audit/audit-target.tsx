// AuditTarget shows an org id as the org's name, with the id on hover. Any other target (an app slug, a host) is
// already readable, and an org this viewer cannot see stays as its id.
export function AuditTarget({ target, orgs }: { target: string; orgs: readonly { id: string; name: string }[] | undefined }) {
  const org = target.startsWith("org__") ? orgs?.find((o) => o.id === target) : undefined;
  return org ? <span title={target}>{org.name}</span> : <>{target}</>;
}
