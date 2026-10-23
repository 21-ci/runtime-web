import { useState, type ReactNode } from "react"

type Page = "home" | "val" | "editor" | "env" | "settings" | "new"
type IconName = "home" | "grid" | "logs" | "heart" | "settings" | "code" | "app" | "chart" | "database" | "blob" | "link" | "lock" | "branch" | "plus" | "search" | "share" | "play" | "history" | "folder" | "file" | "copy" | "external" | "bot" | "send" | "paperclip" | "chevron" | "more" | "user" | "bell" | "key" | "card" | "clock" | "globe" | "mail" | "upload" | "image" | "menu" | "sun" | "help" | "logout" | "edit" | "trash" | "check" | "eye" | "close"

const paths: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  logs: (
    <>
      <path d="M6 4h12v4H6zM6 10h12v4H6zM6 16h12v4H6z" />
      <path d="M3 6h1M3 12h1M3 18h1" />
    </>
  ),
  heart: (
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  code: <path d="m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12" />,
  app: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18M7 7h.01" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  blob: (
    <>
      <path d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M8 8c3 0 4 0 5-1s2-1 3-1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2" />
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="m8 11 8-5M8 13l8 5" />
    </>
  ),
  play: <path d="m9 7 8 5-8 5Z" />,
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  folder: <path d="M3 6h7l2 2h9v11H3Z" />,
  file: (
    <>
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="12" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v7H4V6h7" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="4" />
      <path d="M12 4v4M9 13h.01M15 13h.01M8 19v2M16 19v2" />
    </>
  ),
  send: (
    <>
      <path d="m5 12 14-8-4 16-3-6Z" />
      <path d="m12 14 7-10" />
    </>
  ),
  paperclip: (
    <path d="m20 12-8 8a6 6 0 0 1-8-8l9-9a4 4 0 0 1 6 6l-9 9a2 2 0 0 1-3-3l8-8" />
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  more: (
    <>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M15 8l2 2M17 6l2 2" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m-4 4 4-4 4 4" />
      <path d="M4 15v5h16v-5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 15-5-5L5 20" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.7 2.7 0 1 1 4.5 2c-1 .8-2 1.2-2 3M12 18h.01" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h10" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16-1 5 5-1L19 9l-4-4Z" />
      <path d="m13 7 4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
}

function Icon({ name, size = 18 }: { name: IconName size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

function Button({
  children,
  variant = "secondary",
  icon,
  className = "",
  onClick,
  title,
}: {
  children?: ReactNode
  variant?: "primary" | "secondary" | "ghost" | "danger"
  icon?: IconName
  className?: string
  onClick?: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      className={`btn btn-${variant} ${className}`}
      onClick={onClick}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

function Field({
  placeholder,
  value,
  className = "",
}: {
  placeholder?: string
  value?: string
  className?: string
}) {
  return (
    <input
      className={`field ${className}`}
      placeholder={placeholder}
      value={value}
      readOnly={value !== undefined}
    />
  )
}

const projectItems: {
  label: string
  icon: IconName
  page?: Page
  count?: string
}[] = [
  { label: "Code", icon: "code", page: "editor" },
  { label: "App", icon: "app" },
  { label: "Logs", icon: "logs" },
  { label: "Analytics", icon: "chart" },
  { label: "SQLite", icon: "database" },
  { label: "Blob Storage", icon: "blob" },
  { label: "Connections", icon: "link" },
  { label: "Env vars", icon: "lock", page: "env", count: "1" },
  { label: "Pull requests", icon: "branch" },
  { label: "Settings", icon: "settings" },
]

function Brand() {
  return <div className="brand">vt</div>
}

function Account({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`account ${compact ? "account-compact" : ""}`}>
      <span className="avatar">A</span>
      {!compact && <strong>aliakseych</strong>}
      <Icon name="chevron" size={14} />
    </div>
  )
}

function Sidebar({
  page,
  setPage,
  settingsMode = false,
}: {
  page: Page
  setPage: (p: Page) => void
  settingsMode?: boolean
}) {
  const [accountOpen, setAccountOpen] = useState(false)
  const main = [
    { label: "Home", icon: "home" as IconName, page: "home" as Page },
    {
      label: "Vals",
      icon: "grid" as IconName,
      page: "val" as Page,
      count: "2",
    },
    { label: "Logs", icon: "logs" as IconName },
    { label: "Likes", icon: "heart" as IconName },
    {
      label: "Settings",
      icon: "settings" as IconName,
      page: "settings" as Page,
    },
  ]
  const settings = [
    ["Preferences", "settings"],
    ["Notifications", "bell"],
    ["Authentication", "key"],
    ["Billing", "card"],
    ["Usage", "chart"],
    ["OAuth clients", "lock"],
    ["API tokens", "key"],
    ["Organizations", "user"],
    ["Custom domains", "globe"],
    ["Custom emails", "mail"],
    ["Crons", "clock"],
    ["Blob storage", "blob"],
    ["Townie history", "bot"],
  ] as [string, IconName][]
  return (
    <aside className="sidebar">
      <div className="side-head">
        <Brand />
        <button
          className="account-button"
          onClick={() => setAccountOpen(!accountOpen)}
        >
          <Account />
        </button>
      </div>
      {!settingsMode && (
        <button className="project-chip" onClick={() => setPage("val")}>
          <span className="val-avatar">T</span>
          <span>
            <small>aliakseych</small>
            <strong>Test</strong>
          </span>
        </button>
      )}
      <nav className="side-nav">
        {(settingsMode
          ? settings.map(([label, icon]) => ({ label, icon }))
          : page === "home"
            ? main
            : projectItems
        ).map((item) => {
          const target = "page" in item ? item.page : undefined
          const active =
            target === page ||
            (settingsMode && item.label === "Preferences") ||
            (page === "val" && item.label === "Vals")
          return (
            <Button
              key={item.label}
              variant="ghost"
              className={`nav-item ${active ? "active" : ""}`}
              icon={item.icon}
              onClick={() => target && setPage(target)}
            >
              <span>{item.label}</span>
              {"count" in item && item.count && <em>{item.count}</em>}
            </Button>
          )
        })}
      </nav>
      <div className="side-bottom">
        <Button variant="ghost" icon="menu" title="Collapse" />
        <span className="ai-badge">AI</span>
        <button
          className="mini-account"
          onClick={() => setAccountOpen(!accountOpen)}
        >
          <span className="avatar">A</span>
          <Icon name="chevron" size={14} />
        </button>
      </div>
      {accountOpen && (
        <AccountMenu onClose={() => setAccountOpen(false)} setPage={setPage} />
      )}
    </aside>
  )
}

function AccountMenu({
  onClose,
  setPage,
}: {
  onClose: () => void
  setPage: (p: Page) => void
}) {
  return (
    <div className="account-menu">
      <Button variant="ghost" icon="user" onClick={onClose}>
        Profile
      </Button>
      <Button variant="ghost" icon="bell" onClick={onClose}>
        Notifications
      </Button>
      <Button
        variant="ghost"
        icon="settings"
        onClick={() => {
          setPage("settings")
          onClose()
        }}
      >
        Settings
      </Button>
      <div className="menu-section">
        <Button variant="primary" icon="sun" title="Light theme" />
        <Button variant="ghost" icon="clock" title="Auto theme" />
        <strong>AUTO</strong>
      </div>
      <Button variant="ghost" icon="help">
        Help <Icon name="chevron" />
      </Button>
      <Button variant="ghost" icon="logout">
        Log out
      </Button>
    </div>
  )
}

function Topbar({
  title,
  page,
  setPage,
  toggleMobile,
}: {
  title: ReactNode
  page: Page
  setPage: (p: Page) => void
  toggleMobile: () => void
}) {
  return (
    <header className="topbar">
      <Button
        variant="ghost"
        icon="menu"
        className="mobile-menu"
        onClick={toggleMobile}
      />
      <div className="top-title">{title}</div>
      <div className="top-actions">
        {page === "home" && (
          <>
            <Button variant="ghost" icon="search" title="Search" />
            <Button icon="plus" onClick={() => setPage("new")}>
              New val
            </Button>
          </>
        )}
        {page === "val" && <Button icon="link">Share</Button>}
        {page === "editor" && (
          <>
            <Button variant="ghost" icon="history">
              History
            </Button>
            <Button variant="ghost">Save</Button>
            <Button variant="primary" icon="play">
              Run
            </Button>
            <Button variant="ghost" icon="more" />
          </>
        )}
        {page === "env" && (
          <>
            <Button variant="primary">Add</Button>
            <Button icon="upload">Export .env</Button>
            <Button icon="upload">Import .env</Button>
          </>
        )}
      </div>
    </header>
  )
}

function Layout({
  page,
  setPage,
  children,
  title,
  settingsMode = false,
  noSidebar = false,
}: {
  page: Page
  setPage: (p: Page) => void
  children: ReactNode
  title: ReactNode
  settingsMode?: boolean
  noSidebar?: boolean
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  return (
    <div className={`app-shell ${noSidebar ? "rail-shell" : ""}`}>
      {!noSidebar && (
        <div className={mobileOpen ? "mobile-side open" : "mobile-side"}>
          <Sidebar
            page={page}
            setPage={(p) => {
              setPage(p)
              setMobileOpen(false)
            }}
            settingsMode={settingsMode}
          />
        </div>
      )}
      <section className="app-main">
        <Topbar
          title={title}
          page={page}
          setPage={setPage}
          toggleMobile={() => setMobileOpen(!mobileOpen)}
        />
        {children}
      </section>
      {!noSidebar && <MobileNav page={page} setPage={setPage} />}
    </div>
  )
}

function MobileNav({
  page,
  setPage,
}: {
  page: Page
  setPage: (p: Page) => void
}) {
  return (
    <nav className="mobile-nav">
      <Button
        variant="ghost"
        icon="home"
        className={page === "home" ? "active" : ""}
        onClick={() => setPage("home")}
      >
        Home
      </Button>
      <Button
        variant="ghost"
        icon="grid"
        className={["val", "editor", "env"].includes(page) ? "active" : ""}
        onClick={() => setPage("val")}
      >
        Vals
      </Button>
      <Button
        variant="primary"
        icon="plus"
        onClick={() => setPage("new")}
        title="New val"
      />
      <Button
        variant="ghost"
        icon="settings"
        className={page === "settings" ? "active" : ""}
        onClick={() => setPage("settings")}
      >
        Settings
      </Button>
    </nav>
  )
}

function ValCard({
  name,
  setPage,
}: {
  name: string
  setPage: (p: Page) => void
}) {
  return (
    <button className="val-card" onClick={() => setPage("val")}>
      <span className="val-letter">{name[0]}</span>
      <span>
        <small>aliakseych</small>
        <strong>{name}</strong>
      </span>
      <em>Public</em>
    </button>
  )
}

function HomePage({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <Layout page="home" setPage={setPage} title="Home">
      <main className="home-content">
        <section className="home-primary">
          <div className="welcome-grid">
            <div className="ask-card">
              <strong>
                <Icon name="bot" /> Ask Townie AI
              </strong>
              <div>
                How can I help you?
                <Button variant="primary" icon="send" title="Send" />
              </div>
            </div>
            <div className="connect-card">
              <div>
                <strong>Connect your AI agent</strong>
                <small>Learn more</small>
              </div>
              <p>
                Follow these instructions to use Val Town from your AI agent
              </p>
              <Button>Connect your AI agent</Button>
            </div>
          </div>
          <div className="section-heading">
            <strong>
              Vals <em>2</em>
            </strong>
            <span>View more</span>
          </div>
          <div className="vals-grid">
            <ValCard name="Test" setPage={setPage} />
            <ValCard name="Demo" setPage={setPage} />
          </div>
        </section>
        <aside className="resource-column">
          <div className="profile-card">
            <Account />
            <Button variant="ghost" icon="card">
              View profile
            </Button>
          </div>
          {[
            [
              "Docs",
              "Learn more about the Val Town platform, APIs, and SDKs.",
              "app",
            ],
            ["From the blog", "Talk of the Town - October 2026", "logs"],
            [
              "Book a demo",
              "Get a 15 minute walkthrough of Val Town with our team.",
              "clock",
            ],
          ].map(([title, body, icon]) => (
            <div className="resource-card" key={title}>
              <strong>
                <Icon name={icon as IconName} />
                {title}
                <Icon name="external" size={14} />
              </strong>
              <p>{body}</p>
            </div>
          ))}
        </aside>
      </main>
    </Layout>
  )
}

function ProjectHeader({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <div className="project-header">
      <span className="project-avatar">T</span>
      <div className="project-name">
        <span>aliakseych</span>
        <strong>Test</strong>
      </div>
      <div className="project-actions">
        <Button variant="ghost" icon="heart" title="Like" />
        <Button icon="branch">Remix</Button>
        <Button variant="primary" onClick={() => setPage("editor")}>
          Edit with AI
        </Button>
      </div>
      <div className="project-tags">
        <span>Public</span>
        <em>HTTP 2</em>
        <small>
          <Icon name="branch" size={14} /> 1 Branch
        </small>
      </div>
    </div>
  )
}

function PreviewPanel({ compact = false }: { compact?: boolean }) {
  return (
    <section className={`preview ${compact ? "compact" : ""}`}>
      <div className="preview-head">
        <strong>
          <Icon name="history" size={15} /> main.ts
        </strong>
        <span>https://aliakseych--b5e60246ae9711.web.val.run</span>
        <Icon name="copy" size={15} />
        <Icon name="external" size={15} />
      </div>
      <div className="pretty">Pretty-print □</div>
      <pre>{`{"ok":true}`}</pre>
    </section>
  )
}

function FileList() {
  return (
    <div className="file-list">
      <div>
        <Icon name="folder" size={16} />
        <strong>untitled-folder-2168</strong>
      </div>
      <div className="selected">
        <span className="ts">H</span>
        <strong>main.ts</strong>
      </div>
      <div>
        <span className="ts">H</span>
        <strong>new-file-3326.ts</strong>
      </div>
    </div>
  )
}

function ValPage({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <Layout page="val" setPage={setPage} title="Test">
      <main className="project-page">
        <ProjectHeader setPage={setPage} />
        <PreviewPanel />
        <section className="code-list">
          <div className="code-list-head">
            <strong>Code</strong>
            <span>
              <Icon name="history" size={15} /> History
            </span>
          </div>
          <div>
            <span>
              <Icon name="folder" size={16} /> untitled-folder-2168
            </span>
            <small>9/22/2026</small>
          </div>
          <div>
            <span>
              <b>H</b> main.ts
            </span>
            <small>aliakseych--b5...7e.web.val.run　 9/12/2026</small>
          </div>
          <div>
            <span>
              <b>H</b> new-file-3326.ts
            </span>
            <small>aliakseych--c6...7e.web.val.run　 9/22/2026</small>
          </div>
        </section>
      </main>
    </Layout>
  )
}

function EditorPage({ setPage }: { setPage: (p: Page) => void }) {
  const [logsOpen, setLogsOpen] = useState(true)
  return (
    <Layout
      page="editor"
      setPage={setPage}
      title={
        <span>
          Code　/　<strong>main.ts</strong>
        </span>
      }
    >
      <main className="editor-page">
        <div className="editor-workspace">
          <aside className="files-panel">
            <div className="branch-select">
              <Icon name="branch" size={15} />
              <strong>main</strong>
              <Icon name="chevron" size={14} />
            </div>
            <FileList />
          </aside>
          <section className="code-editor">
            <div className="endpoint">
              <em>HTTP</em>
              <span>https://aliakseych--b5e60246ae9711.web.val.run</span>
              <Icon name="copy" size={15} />
              <Icon name="edit" size={15} />
              <Icon name="external" size={15} />
              <strong>Preview</strong>
            </div>
            <pre>
              <span>1</span>{" "}
              <i>// Learn more: https://docs.val.town/vals/http/</i>
              {"\n"}
              <span>2</span> <b>export default async function</b> (req:
              Request): Response {"{"}
              {"\n"}
              <span>3</span>　 <b>return</b> Response.json({"{"} ok: true {"}"})
              {"\n"}
              <span>4</span> {"}"}
            </pre>
          </section>
          <PreviewPanel compact />
        </div>
        <button className="log-toggle" onClick={() => setLogsOpen(!logsOpen)}>
          <span>
            <Icon name="logs" size={15} /> Logs
          </span>
          <span>
            <span className="green-dot" /> DenoLS
          </span>
        </button>
        {logsOpen && (
          <section className="logs-panel">
            <div>
              <strong>LOGS</strong>
              <span>TRACES</span>
              <span>RAW LOGS</span>
            </div>
            <p>
              1:38:28 AM　 <b>H</b> main.ts{" "}
              <span>
                GET / <em>200</em>
              </span>
              <small>334 ms</small>
            </p>
            <p>
              1:38:39 AM　 <b>H</b> main.ts{" "}
              <span>
                GET / <em>200</em>
              </span>
              <small>119 ms</small>
            </p>
          </section>
        )}
      </main>
    </Layout>
  )
}

function EnvPage({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <Layout page="env" setPage={setPage} title="Environment variables">
      <main className="env-page">
        <div className="env-table">
          <div className="env-row env-head">
            <strong>Key</strong>
            <strong>Value</strong>
            <strong>Description</strong>
            <span />
          </div>
          <div className="env-row">
            <span>
              test　
              <Icon name="copy" size={15} />
            </span>
            <span>••••••••</span>
            <span>Added 5s ago</span>
            <span>
              <Button variant="ghost" icon="edit" title="Edit" />
              <Button variant="danger" icon="trash" title="Delete" />
            </span>
          </div>
        </div>
      </main>
    </Layout>
  )
}

function SettingsPage({ setPage }: { setPage: (p: Page) => void }) {
  return (
    <Layout page="settings" setPage={setPage} title="Settings" settingsMode>
      <main className="settings-page">
        <section className="settings-card">
          <div className="card-title">PUBLIC PROFILE</div>
          <label>Avatar</label>
          <div className="upload-box">
            <Icon name="image" size={24} />
            <span>
              <strong>Upload image</strong>
              <small>Drag and drop an image here</small>
            </span>
          </div>
          <label>Display name (optional)</label>
          <Field />
          <label>Bio</label>
          <textarea
            className="field textarea"
            placeholder="Add a short blurb for your profile"
          />
          <small>Plain-text. URLs are linked automatically.</small>
          <label>Social links</label>
          <Field placeholder="https://github.com/@username" />
          <Field placeholder="https://twitter.com/@username" />
          <Field placeholder="https://bsky.app/profile/username" />
          <Button variant="primary" className="save-button">
            Save changes
          </Button>
        </section>
        <section className="settings-card handle-card">
          <div className="card-title">HANDLE</div>
          <label>Handle</label>
          <Field value="aliakseych" />
          <small>0 of 5 renames used</small>
        </section>
      </main>
    </Layout>
  )
}

function Assistant() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  return (
    <aside className="assistant">
      <header>
        <strong>
          <Icon name="bot" /> Townie <span>AI</span>
        </strong>
        <div>
          <Button
            variant="ghost"
            icon="more"
            onClick={() => setMenuOpen(!menuOpen)}
          />
          <Button variant="ghost" icon="edit" />
          <Button variant="ghost" icon="external" />
          <Button variant="ghost" icon="close" />
        </div>
      </header>
      {menuOpen && (
        <div className="assistant-menu">
          <Button variant="ghost" icon="edit">
            Start new chat
          </Button>
          <Button variant="ghost">
            Model <Icon name="chevron" />
          </Button>
          <Button variant="ghost">
            Mode <Icon name="chevron" />
          </Button>
          <Button variant="ghost" icon="check">
            Show thinking
          </Button>
          <Button variant="ghost" icon="check">
            Auto-clear old tool uses
          </Button>
        </div>
      )}
      <div className="assistant-body">
        <Icon name="bot" />
        <p>How can I help you?</p>
        <div className="agent-card">
          Use Val Town from Claude, ChatGPT, Codex, or Cursor
          <Button>Connect your AI agent</Button>
        </div>
      </div>
      <div className="composer-wrap">
        {scopeOpen && (
          <div className="scope-menu">
            <Field placeholder="Search vals..." />
            <p>
              <Icon name="check" /> aliakseych/Test
            </p>
            <p>　 aliakseych/Demo</p>
            <div>
              <Icon name="close" /> Clear scope
            </div>
          </div>
        )}
        <div className="composer">
          <span>Ask anything about your vals...</span>
          <div>
            <Icon name="paperclip" />
            <Button variant="primary" icon="send" />
          </div>
        </div>
        <div className="composer-meta">
          <button onClick={() => setScopeOpen(!scopeOpen)}>
            aliakseych/...{" "}
          </button>
          <span>Allow all edits　·　DeepSeek Flash</span>
          <Icon name="settings" size={16} />
        </div>
      </div>
    </aside>
  )
}

function NewValPage({ setPage }: { setPage: (p: Page) => void }) {
  const [visibility, setVisibility] = useState("Public")
  return (
    <div className="new-page">
      <aside className="icon-rail">
        <Account compact />
        <Button variant="ghost" icon="home" onClick={() => setPage("home")} />
        <Button variant="ghost" icon="grid" onClick={() => setPage("val")} />
        <Button variant="ghost" icon="logs" />
        <Button variant="ghost" icon="heart" />
        <Button
          variant="ghost"
          icon="settings"
          onClick={() => setPage("settings")}
        />
        <div />
        <Button variant="ghost" icon="menu" />
        <Button variant="primary" icon="bot" />
        <Account compact />
      </aside>
      <section className="new-main">
        <Topbar
          title="Create new val"
          page="new"
          setPage={setPage}
          toggleMobile={() => setPage("home")}
        />
        <main className="create-form">
          <div className="two-fields">
            <label>
              Owner
              <Field value="aliakseych" />
            </label>
            <label>
              Name
              <Field placeholder="my-val-name" />
            </label>
          </div>
          <label>
            Description
            <Field placeholder="Add a description..." />
          </label>
          <label>
            Image
            <div className="upload-box large">
              <Icon name="image" size={24} />
              <span>
                <strong>Upload image</strong>
                <small>Drag and drop image here</small>
              </span>
            </div>
          </label>
          <div className="visibility">
            {[
              ["Public", "Code visible to everyone", "eye"],
              ["Unlisted", "Code only visible with link", "link"],
              ["Private", "Code visible only to you", "lock"],
            ].map(([name, desc, icon]) => (
              <button
                className={visibility === name ? "selected" : ""}
                onClick={() => setVisibility(name)}
                key={name}
              >
                <span className="radio">{visibility === name && <i />}</span>
                <Icon name={icon as IconName} />
                <strong>{name}</strong>
                <small>{desc}</small>
              </button>
            ))}
          </div>
          <p className="form-note">
            Private and unlisted vals are not available on the free tier.{" "}
            <span>Upgrade to Pro</span>
          </p>
          <Button variant="primary">Create val</Button>
          <div className="book-card">
            <span>Want help getting started?</span>
            <Button>Book a call</Button>
          </div>
        </main>
      </section>
      <Assistant />
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>("home")
  if (page === "new") return <NewValPage setPage={setPage} />
  if (page === "val") return <ValPage setPage={setPage} />
  if (page === "editor") return <EditorPage setPage={setPage} />
  if (page === "env") return <EnvPage setPage={setPage} />
  if (page === "settings") return <SettingsPage setPage={setPage} />
  return <HomePage setPage={setPage} />
}
