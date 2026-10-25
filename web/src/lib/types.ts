// Shared API shapes from docs/reference/api.md §2. Timestamps are unix milliseconds.
export type User = {
  id: string;
  email: string;
  name: string;
  instance_admin: boolean;
  must_change_password: boolean;
  disabled: boolean;
  totp_enabled: boolean;
  created_at: number;
};

export type OrgRole = "owner" | "admin" | "member";
