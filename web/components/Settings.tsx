// Settings (F17, docs/PRINCIPLES.md §2): every setting in one screen, in sections. On a laptop the
// sections are a list beside the open one; on the iPhone the list comes first and a section
// opens in its place, with a way back. Opened by openSettings() (web/lib/settings.ts).

import { useEffect, useRef, useState } from "react";
import type { User, Vault } from "../lib/api";
import { closeSettings, type SettingsSection, useSettings } from "../lib/settings";
import { useNarrow } from "../lib/useNarrow";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { AccountSettings, AdminSettings } from "./Account";
import { Assistants } from "./Assistants";
import { CloudConnection, CloudVaultSettings, MacsSignedIn } from "./CloudLibrary";
import { ConnectClaude } from "./ConnectClaude";
import { GitHubAccount } from "./GitHubVault";
import { Connections } from "./Connections";
import { ShareFromPhone } from "./ShareFromPhone";
import { SiteSettings } from "./SiteSettings";
import { VaultSettings } from "./VaultSettings";

interface Props {
  vault: Vault;
  user: User;
  library: string;
  onVaultChanged: () => void;
  onAccountChanged: () => void;
}

/** Mounted once in App; shows Settings whenever openSettings() has opened it. */
export function SettingsHost(p: Props) {
  const { open, seq } = useSettings();
  if (!open) return null;
  return <Settings {...p} initial={open} seq={seq} />;
}

function Settings({ vault, user, library, onVaultChanged, onAccountChanged, initial, seq }: Props & { initial: SettingsSection | "list"; seq: number }) {
  const narrow = useNarrow();
  const [section, setSection] = useState<SettingsSection | null>(initial === "list" ? null : initial);
  // Opened again at another section (a shortcut from inside a dialog): go there.
  useEffect(() => void (initial !== "list" && setSection(initial)), [seq]);

  const sections: { id: SettingsSection; label: string; icon: string; hint: string }[] = [
    { id: "account", label: "Account", icon: "user", hint: "Name, password, sign out" },
    { id: "vault", label: "This collection", icon: "vault", hint: `${vault.name}: members, import, export` },
    { id: "site", label: "Website", icon: "globe", hint: "Publish this collection as a site" },
    { id: "assistants", label: "AI assistants", icon: "sparkle", hint: "Your own AI keys and limits" },
    { id: "connections", label: "Connections", icon: "link", hint: "Claude, Longview, Recall, GitHub, Share from iPhone" },
    ...(user.is_admin ? [{ id: "admin" as const, label: "Admin", icon: "users", hint: "Accounts and storage" }] : []),
  ];
  // On a laptop a section is always open; the list alone is the iPhone's first screen.
  const shown = sections.find((s) => s.id === section)?.id ?? (narrow ? null : "account");
  // A section starts at its top, not where the last one was scrolled to.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = box.current?.closest(".modal-body");
    if (body) body.scrollTop = 0;
  }, [shown]);
  const title = narrow && shown ? sections.find((s) => s.id === shown)!.label : "Settings";

  return (
    <Modal title={title} onClose={closeSettings} size="wide">
      <div ref={box} className={`settings${shown ? " has-section" : ""}`}>
        <nav className="settings-nav" aria-label="Settings">
          {sections.map((s) => (
            <button key={s.id} className={shown === s.id ? "on" : ""} aria-current={shown === s.id ? "page" : undefined} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} size={16} />
              <span className="settings-nav-text">
                {s.label}
                <small>{s.hint}</small>
              </span>
              <span className="only-narrow">
                <Icon name="chevron" size={16} />
              </span>
            </button>
          ))}
        </nav>
        {shown && (
          <div className="settings-pane" key={shown}>
            <button className="quiet settings-back only-narrow" onClick={() => setSection(null)}>
              <Icon name="chevron-left" size={16} /> Settings
            </button>
            {shown === "account" && <AccountSettings user={user} onChanged={onAccountChanged} />}
            {shown === "vault" && (vault.cloud ? <CloudVaultSettings vault={vault} /> : <VaultSettings vault={vault} user={user} onClose={closeSettings} onChanged={onVaultChanged} />)}
            {shown === "site" && (vault.cloud ? <CloudVaultSettings vault={vault} /> : <SiteSettings vault={vault} />)}
            {shown === "assistants" && <Assistants />}
            {shown === "connections" && (
              <>
                <CloudConnection />
                <ConnectClaude />
                <Connections />
                <MacsSignedIn />
                <GitHubAccount />
                <ShareFromPhone />
              </>
            )}
            {shown === "admin" && <AdminSettings user={user} library={library} onChanged={onAccountChanged} />}
          </div>
        )}
      </div>
    </Modal>
  );
}
