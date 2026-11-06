import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuditTarget } from "./audit-target";

const orgs = [{ id: "org__01ABC", name: "Default" }];

describe("AuditTarget", () => {
  it("names a known org and keeps the id on hover", () => {
    render(<AuditTarget target="org__01ABC" orgs={orgs} />);
    expect(screen.getByText("Default")).toHaveAttribute("title", "org__01ABC");
  });

  it("leaves other targets and unknown orgs as they are", () => {
    render(
      <>
        <p><AuditTarget target="hello" orgs={orgs} /></p>
        <p><AuditTarget target="org__GONE" orgs={orgs} /></p>
        <p><AuditTarget target="org__01ABC" orgs={undefined} /></p>
      </>,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("org__GONE")).toBeInTheDocument();
    expect(screen.getByText("org__01ABC")).toBeInTheDocument();
  });
});
