/* Logger serveur — niveaux classiques, configurable par LOG_LEVEL
   (error < warn < info < debug < trace ; défaut "info"). Scope optionnel. */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
const LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"];

export class Logger {
  private threshold: number;

  constructor(level: LogLevel | string = "info", private readonly scope = "") {
    this.threshold = Logger.rank(level);
  }

  /** Rang d'un niveau (inconnu → "info"). */
  static rank(l: LogLevel | string): number {
    const i = LEVELS.indexOf(String(l).toLowerCase() as LogLevel);
    return i < 0 ? LEVELS.indexOf("info") : i;
  }
  /** Logger racine depuis l'environnement (LOG_LEVEL). */
  static fromEnv(): Logger { return new Logger(process.env.LOG_LEVEL || "info"); }

  get level(): LogLevel { return LEVELS[this.threshold]; }
  setLevel(l: LogLevel | string): void { this.threshold = Logger.rank(l); }
  /** Logger fils préfixé (ex. log.child("http")). */
  child(scope: string): Logger { return new Logger(this.level, scope); }

  private emit(level: LogLevel, args: any[]): void {
    if (Logger.rank(level) > this.threshold) return;
    const ts = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    const sc = this.scope ? " [" + this.scope + "]" : "";
    const fn = level === "error" ? console.error
      : level === "warn" ? console.warn
      : (level === "debug" || level === "trace") ? console.debug
      : console.log;
    fn(`${ts} ${tag}${sc}`, ...args);
  }
  error(...a: any[]): void { this.emit("error", a); }
  warn(...a: any[]): void { this.emit("warn", a); }
  info(...a: any[]): void { this.emit("info", a); }
  debug(...a: any[]): void { this.emit("debug", a); }
  trace(...a: any[]): void { this.emit("trace", a); }
}
