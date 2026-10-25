import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { AuthForm, FormField } from "./auth-form";

function Harness({ errors }: { errors: Record<string, string> }) {
  const [, setTick] = useState(0);
  return (
    <AuthForm errors={errors} onSubmit={() => setTick((n) => n + 1)}>
      <FormField label="Email" name="email" error={errors.email} />
      <FormField label="Password" name="password" type="password" error={errors.password} />
    </AuthForm>
  );
}

describe("AuthForm", () => {
  it("focuses the first invalid field when errors appear", () => {
    const { rerender } = render(<Harness errors={{}} />);
    rerender(<Harness errors={{ email: "Enter your email.", password: "Enter your password." }} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
  });

  it("does not steal focus when a later field is the only new error", () => {
    const { rerender } = render(<Harness errors={{ email: "Bad email." }} />);
    screen.getByLabelText("Password").focus();
    rerender(<Harness errors={{ email: "Bad email.", password: "Required." }} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });
});
