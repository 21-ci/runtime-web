package runtime

import "encoding/json"

// Types mirror openapi.json component schemas (runtime v0.1.1). Nullable
// scalars are pointers; free-form objects are json.RawMessage. Timestamps are
// unix ms.

// Tenant is TenantView.
type Tenant struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Plan      string          `json:"plan"`
	Overrides json.RawMessage `json:"overrides,omitempty"`
	CreatedAt int64           `json:"created_at"`
	Disabled  bool            `json:"disabled"`
}

// TenantCreate is CreateTenantBody.
type TenantCreate struct {
	Name      string          `json:"name"`
	Plan      string          `json:"plan"`
	Overrides json.RawMessage `json:"overrides,omitempty"`
}

// KeyCreate is CreateKeyBody. Empty ProjectIDs or Environments are omitted
// (sent as null: no restriction); the runtime's explicit [] (nothing) is never sent.
type KeyCreate struct {
	Name         string   `json:"name,omitempty"`
	Scopes       []string `json:"scopes"`
	ProjectIDs   []string `json:"project_ids,omitempty"`
	Environments []string `json:"environments,omitempty"`
	ExpiresAt    string   `json:"expires_at,omitempty"` // RFC 3339
}

// Key is KeyView.
type Key struct {
	ID           string   `json:"id"`
	Name         *string  `json:"name"`
	Scopes       []string `json:"scopes"`
	ProjectIDs   []string `json:"project_ids"`  // nil = every project
	Environments []string `json:"environments"` // nil = every environment
	CreatedAt    int64    `json:"created_at"`
	ExpiresAt    *int64   `json:"expires_at"`
	LastUsedAt   *int64   `json:"last_used_at"`
}

// KeyCreated is KeyView plus the one-time secret.
type KeyCreated struct {
	Key
	Secret string `json:"secret"`
}

// Usage is UsageView (one service, one day).
type Usage struct {
	ServiceID    string `json:"service_id"`
	Day          string `json:"day"`
	Invocations  int64  `json:"invocations"`
	CPUMs        int64  `json:"cpu_ms"`
	EgressBytes  int64  `json:"egress_bytes"`
	StorageBytes int64  `json:"storage_bytes"`
}

// Quota is QuotaView; nil Limit/Remaining = unlimited.
type Quota struct {
	Limit     *int64 `json:"limit"`
	Used      int64  `json:"used"`
	Remaining *int64 `json:"remaining"`
	Period    string `json:"period"`
}

// Limits is LimitsView.
type Limits struct {
	Plan         string `json:"plan"`
	Day          string `json:"day"`
	ResetsAt     int64  `json:"resets_at"`
	Invocations  Quota  `json:"invocations"`
	EgressBytes  Quota  `json:"egress_bytes"`
	StorageBytes Quota  `json:"storage_bytes"`
	Services     Quota  `json:"services"`
	Schedules    Quota  `json:"schedules"`
}

// Plan is PlanView.
type Plan struct {
	Name     string          `json:"name"`
	Settings json.RawMessage `json:"settings"`
}

// Me is MeView.
type Me struct {
	Principal    string   `json:"principal"`
	TenantID     *string  `json:"tenant_id"`
	KeyID        *string  `json:"key_id"`
	Scopes       []string `json:"scopes"`
	ProjectIDs   []string `json:"project_ids"`  // nil = every project
	Environments []string `json:"environments"` // nil = every environment
	Plan         *Plan    `json:"plan"`
	Version      string   `json:"version"`
}

// Project is ProjectView.
type Project struct {
	ID           string   `json:"id"`
	TenantID     string   `json:"tenant_id"`
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	Environments []string `json:"environments"`
	CreatedAt    int64    `json:"created_at"`
	UpdatedAt    int64    `json:"updated_at"`
}

// ProjectCreate is CreateProjectBody.
type ProjectCreate struct {
	Slug         string   `json:"slug"`
	Name         *string  `json:"name,omitempty"`
	Environments []string `json:"environments,omitempty"`
}

// ProjectPatch is PatchProjectBody; Environments is the complete new list.
type ProjectPatch struct {
	Name         *string  `json:"name,omitempty"`
	Environments []string `json:"environments,omitempty"`
}

// Service is ServiceView.
type Service struct {
	ID          string          `json:"id"`
	TenantID    string          `json:"tenant_id"`
	Slug        string          `json:"slug"`
	Runtime     string          `json:"runtime"`
	Name        *string         `json:"name"`
	Profile     *string         `json:"profile"`
	ProjectID   string          `json:"project_id"`
	Project     string          `json:"project"`
	Environment string          `json:"environment"`
	LiveVersion *int            `json:"live_version"`
	Durable     bool            `json:"durable"`
	WS          json.RawMessage `json:"ws,omitempty"`
	ETag        string          `json:"etag"`
	Limits      json.RawMessage `json:"limits,omitempty"`
	Scaling     json.RawMessage `json:"scaling,omitempty"`
	Access      string          `json:"access"`
	Triggers    json.RawMessage `json:"triggers,omitempty"`
	Ingress     json.RawMessage `json:"ingress,omitempty"`
	Egress      json.RawMessage `json:"egress,omitempty"`
	Call        json.RawMessage `json:"call,omitempty"`
	Deno        json.RawMessage `json:"deno,omitempty"`
	Wasm        json.RawMessage `json:"wasm,omitempty"`
	Status      ServiceStatus   `json:"status"`
	Effective   json.RawMessage `json:"effective,omitempty"`
}

// ServiceStatus is ServiceStatus.
type ServiceStatus struct {
	BuildState string     `json:"build_state"`
	Tier       string     `json:"tier"`
	Inflight   int        `json:"inflight"`
	LastError  *string    `json:"last_error"`
	Admission  *Admission `json:"admission"`
}

// Admission is AdmissionView (queueing/autoscaler state); nil while none.
type Admission struct {
	Kind              string       `json:"kind"`
	Limit             int          `json:"limit"`
	Min               int          `json:"min"`
	Max               int          `json:"max"`
	Running           int          `json:"running"`
	Queued            int          `json:"queued"`
	QueuedBytes       int64        `json:"queued_bytes"`
	MaxQueued         int          `json:"max_queued"`
	QueueWaitMs       float64      `json:"queue_wait_ms"`
	QueueTimeouts     int64        `json:"queue_timeouts"`
	Demand            float64      `json:"demand"`
	LatencyBaselineMs *float64     `json:"latency_baseline_ms"`
	WarmPerProc       int          `json:"warm_per_proc"`
	Instances         int          `json:"instances"`
	MinInstances      int          `json:"min_instances"`
	MaxInstances      int          `json:"max_instances"`
	TargetInstances   int          `json:"target_instances"`
	RPS               float64      `json:"rps"`
	LastChange        *LimitChange `json:"last_change"`
	IdleMs            int64        `json:"idle_ms"`
}

// LimitChange is LimitChangeView.
type LimitChange struct {
	Reason string `json:"reason"`
	From   int    `json:"from"`
	To     int    `json:"to"`
	AgoMs  int64  `json:"ago_ms"`
}

// ServiceCreate is CreateServiceBody.
type ServiceCreate struct {
	Slug        string          `json:"slug"`
	Runtime     string          `json:"runtime"`
	Name        *string         `json:"name,omitempty"`
	Profile     *string         `json:"profile,omitempty"`
	Project     *string         `json:"project,omitempty"`
	Environment *string         `json:"environment,omitempty"`
	Access      *string         `json:"access,omitempty"`
	Limits      json.RawMessage `json:"limits,omitempty"`
	Scaling     json.RawMessage `json:"scaling,omitempty"`
	Triggers    json.RawMessage `json:"triggers,omitempty"`
	Ingress     json.RawMessage `json:"ingress,omitempty"`
	Egress      json.RawMessage `json:"egress,omitempty"`
	Call        json.RawMessage `json:"call,omitempty"`
	Deno        json.RawMessage `json:"deno,omitempty"`
	Wasm        json.RawMessage `json:"wasm,omitempty"`
}

// ServicePatch is PatchServiceBody; each provided block replaces that block.
type ServicePatch struct {
	Name        *string         `json:"name,omitempty"`
	Profile     *string         `json:"profile,omitempty"`
	Project     *string         `json:"project,omitempty"`
	Environment *string         `json:"environment,omitempty"`
	Access      *string         `json:"access,omitempty"`
	Limits      json.RawMessage `json:"limits,omitempty"`
	Scaling     json.RawMessage `json:"scaling,omitempty"`
	Triggers    json.RawMessage `json:"triggers,omitempty"`
	Ingress     json.RawMessage `json:"ingress,omitempty"`
	Egress      json.RawMessage `json:"egress,omitempty"`
	Call        json.RawMessage `json:"call,omitempty"`
	Deno        json.RawMessage `json:"deno,omitempty"`
	Wasm        json.RawMessage `json:"wasm,omitempty"`
}

// ServiceFilter are GET /v1/services query params.
type ServiceFilter struct {
	Slug        string
	Project     string
	Environment string
	Cursor      string
}

// Version is VersionView.
type Version struct {
	Version      int             `json:"version"`
	SourceDigest string          `json:"source_digest"`
	LockDigest   *string         `json:"lock_digest"`
	BuildState   string          `json:"build_state"`
	Failure      *VersionFailure `json:"failure"`
	CreatedAt    int64           `json:"created_at"`
}

// VersionFailure is VersionView.failure.
type VersionFailure struct {
	Reason      string          `json:"reason"`
	Message     string          `json:"message"`
	Diagnostics json.RawMessage `json:"diagnostics,omitempty"`
}

// UploadOpts are POST /versions query params. Compile is "lazy" | "eager".
type UploadOpts struct {
	Activate bool
	Compile  string
}

// SetLiveBody is SetLiveBody.
type SetLiveBody struct {
	Version int `json:"version"`
}

// OnceSchedule is OnceScheduleView: a pending one-off std:schedule task.
type OnceSchedule struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	RunAt int64  `json:"run_at"`
}

// OncePage is OncePage.
type OncePage = Page[OnceSchedule]

// SecretName is SecretNameView.
type SecretName struct {
	Name      string `json:"name"`
	UpdatedAt int64  `json:"updated_at"`
}

// PutSecretBody is PutSecretBody.
type PutSecretBody struct {
	Value string `json:"value"`
}

// Schedule is ScheduleView.
type Schedule struct {
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	Cron         *string         `json:"cron"`
	EverySeconds *int64          `json:"every_seconds"`
	Timezone     *string         `json:"timezone"`
	Payload      json.RawMessage `json:"payload"`
	Enabled      bool            `json:"enabled"`
	NextDue      *int64          `json:"next_due"`
}

// ScheduleBody is ScheduleBody (POST and PATCH).
type ScheduleBody struct {
	Kind         string          `json:"kind"`
	Cron         *string         `json:"cron,omitempty"`
	EverySeconds *int64          `json:"every_seconds,omitempty"`
	Timezone     *string         `json:"timezone,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	Enabled      *bool           `json:"enabled,omitempty"`
}

// QueueStats is QueueStatsView.
type QueueStats struct {
	Depth       int64 `json:"depth"`
	InFlight    int64 `json:"in_flight"`
	OldestAgeMs int64 `json:"oldest_age_ms"`
	DLQ         int64 `json:"dlq"`
}

// EnqueueBody is EnqueueBody.
type EnqueueBody struct {
	Body         json.RawMessage `json:"body"`
	DelaySeconds *int64          `json:"delay_seconds,omitempty"`
	DedupID      *string         `json:"dedup_id,omitempty"`
}

// Enqueued is Enqueued.
type Enqueued struct {
	ID string `json:"id"`
}

// DLQItem is one GET /dlq item (schema is a bare object in openapi).
type DLQItem struct {
	ID       string          `json:"id"`
	Body     json.RawMessage `json:"body"`
	Attempts int             `json:"attempts"`
	FailedAt int64           `json:"failed_at"`
}

// DLQ is GET /v1/services/{s}/dlq.
type DLQ struct {
	Items []DLQItem `json:"items"`
}

// Redriven is Redriven.
type Redriven struct {
	Redriven int64 `json:"redriven"`
}

// Host is HostView.
type Host struct {
	Host        string  `json:"host"`
	Status      string  `json:"status"`
	VerifyToken *string `json:"verify_token"`
	CreatedAt   int64   `json:"created_at"`
	ExpiresAt   *int64  `json:"expires_at"`
}

// Event is EventView.
type Event struct {
	ID   string          `json:"id"`
	TS   int64           `json:"ts"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

// NodeStatus is NodeStatus.
type NodeStatus struct {
	Version        string          `json:"version"`
	Mode           string          `json:"mode"`
	DefaultProfile string          `json:"default_profile"`
	V8Sandbox      bool            `json:"v8_sandbox"`
	Processors     int             `json:"processors"`
	Kinds          json.RawMessage `json:"kinds"`
	Memory         json.RawMessage `json:"memory"`
	Inflight       int             `json:"inflight"`
	Sockets        json.RawMessage `json:"sockets,omitempty"` // {open, objects, pending, max}
}

// NodeConfigUpdate is NodeConfigUpdate.
type NodeConfigUpdate struct {
	DefaultProfile  *string         `json:"default_profile,omitempty"`
	DegradationMode *string         `json:"degradation_mode,omitempty"`
	RateLimit       json.RawMessage `json:"rate_limit,omitempty"`
}

// NodeConfigApplied is NodeConfigApplied.
type NodeConfigApplied struct {
	Applied        []string `json:"applied"`
	PendingRestart []string `json:"pending_restart"`
}
