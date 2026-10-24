import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Badge } from "./badge";
import { IconTile, LetterTile, hueFor } from "./icon-tile";
import { Kbd, PageHeader, SectionLabel, StatTile } from "./page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { CopyButton, UrlBar } from "./url-bar";
import { Boxes } from "lucide-react";

describe("UrlBar", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the URL, copies it and reloads", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const onReload = vi.fn();
    render(<UrlBar url="https://run.example.test/s/hello/" badge={<Badge>HTTP</Badge>} onReload={onReload} />);
    expect(screen.getByRole("link", { name: "https://run.example.test/s/hello/" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "https://run.example.test/s/hello/");
    await userEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(writeText).toHaveBeenCalledWith("https://run.example.test/s/hello/");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("copy button returns to its label after a moment", async () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: () => Promise.resolve() } });
    render(<CopyButton text="abc" label="Copy slug" />);
    await act(async () => {
      screen.getByRole("button", { name: "Copy slug" }).click();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole("button", { name: "Copy slug" })).toBeInTheDocument();
  });
});

describe("page primitives", () => {
  it("page header renders title, description and actions", () => {
    render(<PageHeader icon={Boxes} entity="apps" title="Apps" description="All apps" actions={<button>New</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Apps" })).toBeInTheDocument();
    expect(screen.getByText("All apps")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("stat tile, section label and kbd render their text", () => {
    render(
      <dl>
        <StatTile label="Requests" value="42" hint="last 5 min" />
        <SectionLabel>General</SectionLabel>
        <Kbd>⌘K</Kbd>
      </dl>,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("last 5 min")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("⌘K")).toBeInTheDocument();
  });

  it("tiles pick a stable hue and the solid variant", () => {
    expect(hueFor("acme")).toBe(hueFor("acme"));
    const { container } = render(
      <>
        <IconTile icon={Boxes} entity="apps" solid size="xl" />
        <LetterTile label="hello" hue="green" size="lg" solid />
        <LetterTile label="" size="xs" />
      </>,
    );
    expect(container.querySelector(".bg-tag-blue-solid")).not.toBeNull();
    expect(container.textContent).toContain("H");
    expect(container.textContent).toContain("?");
  });

  it("badge shows a dot and tabs support the segmented variant", async () => {
    const { container } = render(
      <>
        <Badge variant="success" dot>
          ready
        </Badge>
        <Tabs defaultValue="a">
          <TabsList variant="segmented">
            <TabsTrigger value="a">Light</TabsTrigger>
            <TabsTrigger value="b">Dark</TabsTrigger>
          </TabsList>
          <TabsContent value="a">light body</TabsContent>
          <TabsContent value="b">dark body</TabsContent>
        </Tabs>
      </>,
    );
    expect(container.querySelector(".bg-tag-green-solid")).not.toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Dark" }));
    expect(await screen.findByText("dark body")).toBeInTheDocument();
  });
});
