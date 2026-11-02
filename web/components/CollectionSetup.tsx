// Settings → This collection → Setup (F20, slim): what a collection is, in one place. Where it's
// kept (on the Mac, possibly in a folder: F22, FolderSetup.tsx), who's in it, whether it's your home (where Share from iPhone sends and the app opens), and
// starter types in sets for the kind of collection it is. The sets become built-in collection
// types later, once a few collections show what repeats.

import { useEffect, useState } from "react";
import { STARTER_SETS, STARTERS } from "../../src/types";
import { api, type Vault } from "../lib/api";
import { addStarters, loadTypes, useTypes } from "../lib/types";
import { Icon } from "../ui/Icon";
import { FolderKept } from "./FolderSetup";
import { toast, toastError } from "../ui/overlays";

export function CollectionSetup({ vault, members, onChanged, onInvite }: { vault: Vault; members: number; onChanged: () => void; onInvite: () => void }) {
  const canWrite = vault.role !== "viewer";
  const { types } = useTypes();
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => void loadTypes(vault.id).catch(() => {}), [vault.id]);
  const has = (n: string) => types.some((t) => t.name.toLowerCase() === n.toLowerCase());

  async function makeHome() {
    setBusy("home");
    try {
      await api("/me/home", { method: "PUT", body: { vaultId: vault.id } });
      onChanged();
      toast(`“${vault.name}” is your home collection`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  async function addSet(name: string, list: string[]) {
    setBusy(name);
    try {
      const added = await addStarters(vault.id, list);
      toast(added.length ? `Added ${added.join(", ")}` : "Those types are all here already");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="settings-section setup">
      <h3>Setup</h3>
      <dl className="setup-facts">
        <dt>
          <Icon name={vault.git_repo ? "branch" : vault.folder ? "folder" : "vault"} size={16} /> Kept
        </dt>
        <dd>
          <FolderKept vault={vault} onChanged={onChanged} />
        </dd>
        <dt>
          <Icon name="users" size={16} /> People
        </dt>
        <dd>
          {members <= 1 ? "Just you" : `${members} people`}
          {vault.role === "owner" && (
            <button className="link" onClick={onInvite}>
              Invite someone
            </button>
          )}
        </dd>
        <dt>
          <Icon name="home" size={16} /> Home
        </dt>
        <dd>
          {vault.home ? (
            "Your home collection: Share from iPhone sends here, and DO Notes opens here."
          ) : (
            <button onClick={() => void makeHome()} disabled={!!busy}>
              Make this my home collection
            </button>
          )}
        </dd>
      </dl>

      {canWrite && (
        <>
          <h4>Starter types</h4>
          <p className="muted small">Types for the kind of collection this is. Add a set; anything already here is left as it is, and every type can be changed or deleted later.</p>
          <ul className="starter-sets">
            {STARTER_SETS.map((set) => {
              const missing = set.types.filter((t) => !has(t));
              return (
                <li key={set.name}>
                  <div className="starter-set-head">
                    <b>{set.name}</b> <span className="muted">{set.about}</span>
                  </div>
                  <div className="starter-set-types">
                    {set.types.map((t) => {
                      const s = STARTERS.find((x) => x.name === t)!;
                      return (
                        <span key={t} className={`setup-type colour-${s.shape.colour}${has(t) ? " added" : ""}`} title={s.about}>
                          <Icon name={has(t) ? "check-plain" : s.shape.icon} size={14} /> {t}
                        </span>
                      );
                    })}
                  </div>
                  <button className={missing.length ? "" : "quiet"} disabled={!missing.length || !!busy} onClick={() => void addSet(set.name, missing)} aria-label={missing.length ? `Add the ${set.name} types: ${missing.join(", ")}` : `${set.name} types all added`}>
                    {busy === set.name ? "Adding…" : missing.length ? `Add ${missing.length === set.types.length ? "these" : `the other ${missing.length}`}` : "All added"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
