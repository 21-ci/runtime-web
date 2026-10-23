package apps

import (
	"context"

	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// Env returns the app's environment variables.
func (s *Service) Env(ctx context.Context, sub authz.Subject, orgID, slug string) (map[string]string, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	env, err := cli.GetEnv(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("get env "+slug, err)
	}
	return env, nil
}

// SetEnv replaces the app's environment variables with env (a complete map).
func (s *Service) SetEnv(ctx context.Context, sub authz.Subject, orgID, slug string, env map[string]string) (map[string]string, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppEnvWrite)
	if err != nil {
		return nil, err
	}
	out, err := cli.PutEnv(ctx, app.SvcID, env)
	if err != nil {
		return nil, mapErr("set env "+slug, err)
	}
	return out, nil
}

// Secrets lists the names and update times of the app's secrets. Values are write-only and never
// returned.
func (s *Service) Secrets(ctx context.Context, sub authz.Subject, orgID, slug string) ([]runtime.SecretName, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	items, err := cli.ListSecrets(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("list secrets "+slug, err)
	}
	if items == nil {
		items = []runtime.SecretName{}
	}
	return items, nil
}

// SetSecret writes secret name. The value is write-only: it is sent to the runtime and then dropped.
func (s *Service) SetSecret(ctx context.Context, sub authz.Subject, orgID, slug, name, value string) error {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppSecretsWrite)
	if err != nil {
		return err
	}
	if err := cli.PutSecret(ctx, app.SvcID, name, value); err != nil {
		return mapErr("set secret "+slug, err)
	}
	return nil
}

// DeleteSecret removes secret name.
func (s *Service) DeleteSecret(ctx context.Context, sub authz.Subject, orgID, slug, name string) error {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppSecretsWrite)
	if err != nil {
		return err
	}
	if err := cli.DeleteSecret(ctx, app.SvcID, name); err != nil {
		return mapErr("delete secret "+slug, err)
	}
	return nil
}

// Schedules lists the app's schedules.
func (s *Service) Schedules(ctx context.Context, sub authz.Subject, orgID, slug string) ([]runtime.Schedule, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	items, err := cli.ListSchedules(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("list schedules "+slug, err)
	}
	if items == nil {
		items = []runtime.Schedule{}
	}
	return items, nil
}

// CreateSchedule adds a schedule. A trigger kind the app's plan does not allow, or a schedule count
// over the plan, is apperr.Forbidden{plan_limit}.
func (s *Service) CreateSchedule(ctx context.Context, sub authz.Subject, orgID, slug string, in runtime.ScheduleBody) (runtime.Schedule, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppSchedulesWrite)
	if err != nil {
		return runtime.Schedule{}, err
	}
	out, err := cli.CreateSchedule(ctx, app.SvcID, in)
	if err != nil {
		return runtime.Schedule{}, mapErr("create schedule "+slug, err)
	}
	return out, nil
}

// UpdateSchedule replaces schedule id with in. The runtime needs the full body, kind included.
func (s *Service) UpdateSchedule(ctx context.Context, sub authz.Subject, orgID, slug, id string, in runtime.ScheduleBody) (runtime.Schedule, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppSchedulesWrite)
	if err != nil {
		return runtime.Schedule{}, err
	}
	out, err := cli.UpdateSchedule(ctx, app.SvcID, id, in)
	if err != nil {
		return runtime.Schedule{}, mapErr("update schedule "+slug, err)
	}
	return out, nil
}

// DeleteSchedule removes schedule id.
func (s *Service) DeleteSchedule(ctx context.Context, sub authz.Subject, orgID, slug, id string) error {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppSchedulesWrite)
	if err != nil {
		return err
	}
	if err := cli.DeleteSchedule(ctx, app.SvcID, id); err != nil {
		return mapErr("delete schedule "+slug, err)
	}
	return nil
}

// Queue returns the app's queue depth, in-flight count, oldest age and dead-letter count.
func (s *Service) Queue(ctx context.Context, sub authz.Subject, orgID, slug string) (runtime.QueueStats, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return runtime.QueueStats{}, err
	}
	st, err := cli.QueueStats(ctx, app.SvcID)
	if err != nil {
		return runtime.QueueStats{}, mapErr("queue "+slug, err)
	}
	return st, nil
}

// Enqueue adds a message to the app's queue. A full queue is the runtime 429 queue_full, passed through
// with its Retry-After.
func (s *Service) Enqueue(ctx context.Context, sub authz.Subject, orgID, slug string, in runtime.EnqueueBody) (runtime.Enqueued, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppQueueWrite)
	if err != nil {
		return runtime.Enqueued{}, err
	}
	out, err := cli.Enqueue(ctx, app.SvcID, in)
	if err != nil {
		return runtime.Enqueued{}, mapErr("enqueue "+slug, err)
	}
	return out, nil
}

// DLQ lists the app's dead-lettered messages.
func (s *Service) DLQ(ctx context.Context, sub authz.Subject, orgID, slug string) ([]runtime.DLQItem, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	page, err := cli.ListDLQ(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("list dlq "+slug, err)
	}
	if page.Items == nil {
		return []runtime.DLQItem{}, nil
	}
	return page.Items, nil
}

// PurgeDLQ deletes every dead-lettered message of the app.
func (s *Service) PurgeDLQ(ctx context.Context, sub authz.Subject, orgID, slug string) error {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppQueueWrite)
	if err != nil {
		return err
	}
	if err := cli.PurgeDLQ(ctx, app.SvcID); err != nil {
		return mapErr("purge dlq "+slug, err)
	}
	return nil
}

// RedriveDLQ moves the dead-lettered messages back onto the queue and reports how many moved.
func (s *Service) RedriveDLQ(ctx context.Context, sub authz.Subject, orgID, slug string) (runtime.Redriven, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppQueueWrite)
	if err != nil {
		return runtime.Redriven{}, err
	}
	out, err := cli.RedriveDLQ(ctx, app.SvcID)
	if err != nil {
		return runtime.Redriven{}, mapErr("redrive dlq "+slug, err)
	}
	return out, nil
}
