import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
    expect(box.className).toMatch(/rounded-2xl/);
    expect(box.className).toMatch(/border-line/);
    expect(box.className).not.toMatch(/border-dashed/);
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
});
