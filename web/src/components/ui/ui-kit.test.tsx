import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EntityTile, hueFor } from "./icon-tile";
import { Badge } from "./badge";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./dialog";
import { EmptyState } from "./empty-state";
import { Input } from "./input";
import { Label } from "./label";
import { Progress } from "./progress";
import { Skeleton } from "./skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function Kit() {
  return (
    <div>
      <Button>Create App</Button>
      <Button variant="danger">Delete</Button>
      <Input aria-label="App name" />
      <Label htmlFor="x">Label</Label>
      <Badge>running</Badge>
      <Progress value={40} aria-label="usage" />
      <Skeleton data-testid="skel" />
      <EmptyState title="No apps" description="Create one to start." />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>billing</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Overview</TabsTrigger>
        </TabsList>
        <TabsContent value="a">overview body</TabsContent>
      </Tabs>
    </div>
  );
}

describe("ui kit", () => {
  it("ui kit renders in light and dark", () => {
    const { unmount } = render(<Kit />);
    expect(screen.getByRole("button", { name: "Create App" })).toBeInTheDocument();
    expect(screen.getByText("No apps")).toBeInTheDocument();
    unmount();

    const { container } = render(
      <div className="dark" data-testid="dark-root">
        <Kit />
      </div>,
    );
    expect(screen.getByTestId("dark-root")).toHaveClass("dark");
    expect(screen.getByRole("button", { name: "Create App" })).toBeInTheDocument();
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("button focus ring visible", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toMatch(/focus-visible:ring-2/);
    expect(button.className).toMatch(/focus-visible:outline-none/);
  });

  it("empty state uses a solid hairline, not a dashed box", () => {
    render(<EmptyState title="No apps" description="Create one to start." />);
    const title = screen.getByText("No apps");
    const box = title.parentElement as HTMLElement;
    expect(box.className).toMatch(/rounded-lg/);
    expect(box.className).toMatch(/border-line/);
    expect(box.className).not.toMatch(/border-dashed/);
  });

  it("stack labels each cell from its header and skips spanning cells", () => {
    const { container } = render(
      <Table stack>
        <TableHeader>
          <TableRow><TableHead>When</TableHead><TableHead>Who</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <TableRow><TableCell>now</TableCell><TableCell>Ada</TableCell></TableRow>
          <TableRow><TableCell colSpan={2}>note</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    expect(container.querySelector("table")?.className).toMatch(/table-stack/);
    const cells = container.querySelectorAll("td");
    expect(cells[0]).toHaveAttribute("data-label", "When");
    expect(cells[1]).toHaveAttribute("data-label", "Who");
    expect(cells[2]).not.toHaveAttribute("data-label");
  });

  it("table uses 40px rows and muted light headers", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>billing</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toMatch(/text-muted/);
    expect(screen.getByRole("cell", { name: "billing" }).className).toMatch(/h-10/);
  });

  it("dialog opens from its trigger and shows title and description", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Rename app</DialogTitle>
          <DialogDescription>Choose a new name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Rename app" })).toBeInTheDocument();
    expect(screen.getByText("Choose a new name.")).toBeInTheDocument();
  });

  it("entity tile is a glyph, never a letter, tinted by name", () => {
    const { container, rerender } = render(<EntityTile kind="app" name="todo" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.textContent).toBe("");
    const tint = tile.className;
    rerender(<EntityTile kind="project" name="todo" />);
    expect((container.firstElementChild as HTMLElement).className).toBe(tint);
    expect(tint).toContain(`bg-tag-${hueFor("todo")}-bg`);
  });

  it("empty state keeps its default look and action", () => {
    render(<EmptyState title="No schedules" description="Add one." action={<Button>Add schedule</Button>} />);
    expect(screen.getByRole("heading", { name: "No schedules" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add schedule" })).toBeInTheDocument();
  });

  it("no-range state is one muted sentence that names the range", () => {
    const { container } = render(<EmptyState variant="no-range" title="No requests in the last hour." />);
    expect(screen.getByText("No requests in the last hour.").className).toMatch(/text-muted/);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("error state is an inline alert with code, retry and collapsed details", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<EmptyState variant="error" title="Could not load logs" code="runtime_unavailable" details="upstream 502" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load logs");
    expect(screen.getByText("runtime_unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText("upstream 502").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Details")).toBeInTheDocument();
  });

  it("permission state is a one-line notice", () => {
    render(<EmptyState variant="permission" title="Only project admins can change this" />);
    expect(screen.getByRole("note")).toHaveTextContent("Only project admins can change this");
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
