// English is the source language: bundled with the app and the shape every other locale must match.
// One namespace per feature folder, so a change to one feature touches only its own JSON files.
// Adding a namespace: create {en,ru,uz}/<name>.json and add one import and one entry here.
import admin from "./en/admin.json";
import appHeader from "./en/app-header.json";
import appSettings from "./en/app-settings.json";
import apps from "./en/apps.json";
import audit from "./en/audit.json";
import auth from "./en/auth.json";
import branding from "./en/branding.json";
import common from "./en/common.json";
import domains from "./en/domains.json";
import editor from "./en/editor.json";
import empty from "./en/empty.json";
import env from "./en/env.json";
import errors from "./en/errors.json";
import invites from "./en/invites.json";
import logs from "./en/logs.json";
import members from "./en/members.json";
import org from "./en/org.json";
import overview from "./en/overview.json";
import secrets from "./en/secrets.json";
import security from "./en/security.json";
import shell from "./en/shell.json";
import tokens from "./en/tokens.json";
import triggers from "./en/triggers.json";
import versions from "./en/versions.json";

export const en = {
  admin,
  "app-header": appHeader,
  "app-settings": appSettings,
  apps,
  audit,
  auth,
  branding,
  common,
  domains,
  editor,
  empty,
  env,
  errors,
  invites,
  logs,
  members,
  org,
  overview,
  secrets,
  security,
  shell,
  tokens,
  triggers,
  versions,
} as const;

export type Namespace = keyof typeof en;
export const NAMESPACES = Object.keys(en) as Namespace[];
