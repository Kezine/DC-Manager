import type { NotificationMessage, Notifier } from "./Notifier.js";

/* Notifier « DUMMY » CONSOLE — canal v1 livré avec le module (cadrage
   2026-07-14) : matérialise le contrat et rend les alertes VISIBLES sans
   aucune configuration (jalon de fin de phase 1). Écrit une ligne par remise
   sur la sortie injectée (console.log par défaut) ; n'échoue jamais.
   Aucun secret en jeu (le message ne transporte pas de jeton). */
export class ConsoleNotifier implements Notifier {
  readonly kind = "console";

  /** @param write  Sortie injectée (testable) — une ligne par notification. */
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  async send(message: NotificationMessage): Promise<void> {
    this.write(
      "[notify] " + message.severity.toUpperCase()
      + " " + message.event_type
      + (message.doc_id ? " (doc " + message.doc_id + ")" : "")
      + " → " + message.target.channel + ":" + message.target.address
      + " — " + message.title
      + (message.body ? " | " + message.body : ""),
    );
  }
}
