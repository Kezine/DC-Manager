import type { NotifyState, NotifyStateStore } from "./NotifyEngine.js";

/* Implémentation MÉMOIRE du NotifyStateStore — état non persistant (perdu au
   redémarrage). Sert les tests du moteur et tout usage sans notify.db ; la
   persistance réelle (SQLite, table notification_states) vit dans NotifyDb (S3).
   Les états sont COPIÉS à l'écriture ET à la lecture : le moteur mute ses
   objets en place, un stockage qui partagerait les références ne détecterait
   plus rien (et masquerait un oubli de set()) — la copie garde au store
   mémoire la même sémantique « photo » qu'une ligne SQL. */
export class MemoryNotifyStateStore implements NotifyStateStore {
  private readonly states = new Map<string, NotifyState>();

  get(key: string): NotifyState | null {
    const state = this.states.get(key);
    return state ? { ...state } : null;
  }

  set(state: NotifyState): void {
    this.states.set(state.key, { ...state });
  }

  listActive(): NotifyState[] {
    return [...this.states.values()].filter((s) => s.resolved_at === null).map((s) => ({ ...s }));
  }
}
