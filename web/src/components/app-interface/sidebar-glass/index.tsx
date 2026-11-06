"use client";

import { ChevronRightIcon, PanelLeftIcon } from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import "./glass.css";

export type GlassNavItem = {
  title: string;
  url: string;
  icon?: ComponentType<{ className?: string }>;
  /** `prefix` (default) is active on the URL and its sub-pages; `exact` only on the URL. */
  match?: "exact" | "prefix";
  /** Shown only to users with one of these roles. No `roles` means everyone. */
  roles?: readonly string[];
  /** Hidden when false. */
  visible?: boolean;
  external?: boolean;
  disabled?: boolean;
  badge?: ReactNode;
  items?: GlassNavItem[];
};

export type GlassNavGroup = { label?: string; items: GlassNavItem[] };

/** Renders your router's link, such as Next.js `Link`. Defaults to a plain anchor. */
export type RenderNavLink = (
  props: ComponentProps<"a"> & { href: string }
) => ReactElement;

const defaultLink: RenderNavLink = (props) => <a {...props} />;

const normalizePath = (path: string) => {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  let end = withoutQuery.length;
  while (end > 0 && withoutQuery.charCodeAt(end - 1) === 47) end--;
  return withoutQuery.slice(0, end) || "/";
};

export const isActivePath = (
  pathname: string | null | undefined,
  url: string,
  match: "exact" | "prefix" = "prefix"
) => {
  if (pathname == null) return false;
  const current = normalizePath(pathname);
  const target = normalizePath(url);
  if (current === target) return true;
  if (match === "exact" || target === "/") return false;
  return current.startsWith(`${target}/`);
};

const isVisibleTo = (item: GlassNavItem, roles: readonly string[]) => {
  if (item.visible === false) return false;
  return !item.roles?.length || item.roles.some((role) => roles.includes(role));
};

/** Drops items the user may not see, and groups left empty. */
export const filterNavGroups = (
  groups: GlassNavGroup[],
  roles: readonly string[]
) =>
  groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => isVisibleTo(item, roles))
        .map((item) =>
          item.items
            ? {
                ...item,
                items: item.items.filter((child) => isVisibleTo(child, roles)),
              }
            : item
        ),
    }))
    .filter((group) => group.items.length > 0);

/** Fades the label without moving the icon, so rows don't jump as the rail collapses. */
const LABEL =
  "min-w-0 flex-1 truncate transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0";

type NavProps = {
  item: GlassNavItem;
  pathname?: string | null;
  renderLink: RenderNavLink;
};

const NavLink = ({ item, pathname, renderLink }: NavProps) => {
  const active = isActivePath(pathname, item.url, item.match);
  const Icon = item.icon;
  const contents = (
    <>
      {Icon && <Icon aria-hidden="true" className="size-4" />}
      <span className={LABEL}>{item.title}</span>
    </>
  );

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-disabled={item.disabled}
        asChild
        isActive={active}
        tooltip={item.title}
      >
        {item.external ? (
          <a href={item.url} rel="noopener noreferrer" target="_blank">
            {contents}
          </a>
        ) : (
          renderLink({
            href: item.url,
            "aria-current": active ? "page" : undefined,
            children: contents,
          })
        )}
      </SidebarMenuButton>
      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  );
};

const NavBranch = ({ item, pathname, renderLink }: NavProps) => {
  const active = isActivePath(pathname, item.url, item.match);
  const Icon = item.icon;
  const { setOpen, state } = useSidebar();

  return (
    <Collapsible asChild className="group/collapsible" defaultOpen={active}>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            isActive={active}
            // Sub-items are hidden on the icon rail, so expand it to show them.
            onClick={() => {
              if (state === "collapsed") setOpen(true);
            }}
            tooltip={item.title}
          >
            {Icon && <Icon aria-hidden="true" className="size-4" />}
            <span className={LABEL}>{item.title}</span>
            <ChevronRightIcon className="shrink-0 transition-transform duration-200 group-data-[collapsible=icon]:hidden group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.items?.map((child) => (
              <SidebarMenuSubItem key={child.url}>
                <SidebarMenuSubButton
                  asChild
                  isActive={isActivePath(pathname, child.url, child.match)}
                >
                  {renderLink({
                    href: child.url,
                    children: <span>{child.title}</span>,
                  })}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
};

const FADE =
  "transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
const REVEAL =
  "scale-75 opacity-0 group-hover/brand:scale-100 group-hover/brand:opacity-100 group-has-[:focus-visible]/brand:scale-100 group-has-[:focus-visible]/brand:opacity-100 [@media(hover:none)]:scale-100 [@media(hover:none)]:opacity-100";
const CONCEAL =
  "group-hover/brand:scale-75 group-hover/brand:opacity-0 group-has-[:focus-visible]/brand:scale-75 group-has-[:focus-visible]/brand:opacity-0 [@media(hover:none)]:opacity-0";
const LOGO_BOX =
  "flex size-6 shrink-0 overflow-hidden rounded-lg [&>img]:size-full [&>svg]:size-full";

export type SidebarBrandProps = {
  logo: ReactNode;
  name: ReactNode;
  href?: string;
  toggleLabel?: string;
  renderLink?: RenderNavLink;
};

/** The logo doubles as the sidebar toggle, crossfading to a panel icon on hover or focus. */
export const SidebarBrand = ({
  logo,
  name,
  href = "/",
  toggleLabel = "Toggle sidebar",
  renderLink = defaultLink,
}: SidebarBrandProps) => {
  const { isMobile, open, toggleSidebar } = useSidebar();

  if (isMobile) {
    return renderLink({
      href,
      className: "flex min-h-11 items-center gap-2 rounded-lg px-1 font-semibold",
      children: (
        <>
          <span className={LOGO_BOX}>{logo}</span>
          <span className="truncate">{name}</span>
        </>
      ),
    });
  }

  return (
    <div className="group/brand flex items-center gap-2">
      <button
        aria-expanded={open}
        aria-label={toggleLabel}
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        onClick={toggleSidebar}
        type="button"
      >
        <span className={cn(LOGO_BOX, FADE, CONCEAL)}>{logo}</span>
        <PanelLeftIcon
          aria-hidden="true"
          className={cn("absolute size-5", FADE, REVEAL)}
        />
      </button>
      {renderLink({
        href,
        className:
          "min-w-0 flex-1 truncate rounded-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden",
        children: name,
      })}
    </div>
  );
};

export type GlassSidebarProps = Omit<
  ComponentProps<typeof Sidebar>,
  "collapsible" | "variant"
> & {
  nav: GlassNavGroup[];
  /** The current path, from your router. */
  pathname?: string | null;
  brand?: ReactNode;
  /** Usually an account row. */
  footer?: ReactNode;
  renderLink?: RenderNavLink;
};

/** A floating glass rail that collapses to icons, and becomes a sheet on phones. */
export const GlassSidebar = ({
  nav,
  pathname,
  brand,
  footer,
  renderLink = defaultLink,
  className,
  children,
  ...props
}: GlassSidebarProps) => (
  <Sidebar
    className={cn("sidebar-glass", className)}
    collapsible="icon"
    variant="floating"
    {...props}
  >
    {brand ? <SidebarHeader>{brand}</SidebarHeader> : null}
    <SidebarContent className="overflow-x-hidden">
      {nav.map((group, index) => (
        <SidebarGroup aria-label={group.label} className="py-0" key={group.label ?? `group-${index}`} role="group">
          {group.label ? (
            <SidebarGroupLabel className="group-data-[collapsible=icon]:mt-0">
              <span className="min-w-0 truncate">{group.label}</span>
            </SidebarGroupLabel>
          ) : null}
          <SidebarMenu>
            {group.items.map((item) =>
              item.items?.length ? (
                <NavBranch
                  item={item}
                  key={item.url}
                  pathname={pathname}
                  renderLink={renderLink}
                />
              ) : (
                <NavLink
                  item={item}
                  key={item.url}
                  pathname={pathname}
                  renderLink={renderLink}
                />
              )
            )}
          </SidebarMenu>
        </SidebarGroup>
      ))}
      {children}
    </SidebarContent>
    {footer ? (
      <SidebarFooter className="sidebar-glass-footer">{footer}</SidebarFooter>
    ) : null}
    <SidebarRail />
  </Sidebar>
);
