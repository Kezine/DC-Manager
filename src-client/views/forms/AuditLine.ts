import { I18n } from "../../i18n/I18n";
import { Format } from "../../core/Format";
import type { UserDirectory } from "../../core/UserDirectory";

/* Ligne d'AUDIT DISCRÈTE d'une fiche détail : « Créé par {auteur} le {date} · Modifié par {auteur} le {date} ».
   Helper PARTAGÉ par TOUTES les fiches détail (principe n°3 : une seule implémentation). L'auteur (id canonique
   posé serveur) est résolu SYNCHRONE depuis l'annuaire (id brut en repli → le legacy « nom en clair » s'affiche
   tel quel) ; un `ensure` asynchrone met le texte À JOUR quand les profils manquants arrivent, SANS reconstruire
   la fiche.

   DÉCOUPLAGE : ne connaît que le contrat `UserDirectory` (injecté via `FormHost.userDirectory`). En mode
   fichier l'annuaire est null → AUCUNE ligne (pas d'identité serveur). Aucune ligne non plus si l'enregistrement
   ne porte AUCUN champ d'audit (fiche legacy sans estampille). */

/** Enregistrement porteur d'un audit serveur (champs optionnels — une fiche legacy peut n'en avoir aucun).
    `created_by`/`updated_by` = IDS canoniques (résolus par l'annuaire) ; legacy = noms en clair. */
export interface AuditRecord {
  created_by?: string;
  created_date?: string;
  updated_by?: string;
  updated_date?: string;
}

export class AuditLine {
  /** Construit la ligne d'audit, ou null si aucun annuaire (mode fichier) ou aucun champ d'audit. */
  static render(record: AuditRecord, directory: UserDirectory | null | undefined): HTMLElement | null {
    if (!directory) return null;   // mode fichier : aucune identité serveur → pas de ligne
    const createdBy = (record.created_by || "").trim();
    const updatedBy = (record.updated_by || "").trim();
    const createdDate = (record.created_date || "").trim();
    const updatedDate = (record.updated_date || "").trim();
    if (!createdBy && !updatedBy && !createdDate && !updatedDate) return null;   // rien à afficher

    const line = document.createElement("div");
    line.className = "audit-line";   // discrète (petite, estompée — cf. dc-manager.css)

    const paint = (): void => {
      const parts: string[] = [];
      const created = AuditLine.part(directory, "created", createdBy, createdDate);
      const updated = AuditLine.part(directory, "updated", updatedBy, updatedDate);
      if (created) parts.push(created);
      if (updated) parts.push(updated);
      line.textContent = parts.join(" · ");
    };
    paint();

    // Résolution asynchrone COALESCÉE des ids manquants → re-peint le texte quand les profils arrivent.
    const ids = [createdBy, updatedBy].filter((x) => x !== "");
    if (ids.length) void directory.ensure(ids).then(paint).catch(() => { /* id brut conservé */ });
    return line;
  }

  /** Ajoute la ligne d'audit à `root` si elle a lieu d'être (helper à UN appel par fiche). */
  static attach(root: HTMLElement, record: AuditRecord, directory: UserDirectory | null | undefined): void {
    const line = AuditLine.render(record, directory);
    if (line) root.appendChild(line);
  }

  /** Fragment « Créé/Modifié par {auteur} le {date} » avec omission propre des champs absents. */
  private static part(directory: UserDirectory, which: "created" | "updated", by: string, date: string): string {
    const author = by ? directory.display(by) : "";
    const when = date ? Format.dateTime(date) : "";
    if (author && when) return I18n.t(which === "created" ? "detail.audit.createdBy" : "detail.audit.updatedBy", { author, date: when });
    if (author) return I18n.t(which === "created" ? "detail.audit.createdByOnly" : "detail.audit.updatedByOnly", { author });
    if (when) return I18n.t(which === "created" ? "detail.audit.createdAt" : "detail.audit.updatedAt", { date: when });
    return "";
  }
}
