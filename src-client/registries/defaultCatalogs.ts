/* CATALOGUES STANDARDISÉS — listes FERMÉES définies dans le code (source de
   vérité unique). À chaque chargement, le Store est réconcilié sur ces listes
   (Store.syncCatalogs). L'`id` est STABLE = clé de référence FK ; pour
   ajouter/modifier un type, ÉDITER CES TABLEAUX.
   - `family`    : clé de COMPATIBILITÉ (un câble relie 2 ports de même famille) ;
   - `connector` : forme PHYSIQUE (taille 3D ; peut différer d'un bout à l'autre) ;
   - `speed`     : débit (informatif) ;
   - `kind`      : "data" | "power".

   NB : données seules (Phase 3). Les registres OO — classes PortTypes / CableTypes
   avec leur comportement — arrivent en Phase 4 et s'appuieront sur ces tableaux. */

export interface PortTypeDef {
  id: string; name: string; family: string; connector: string; speed: string; kind: "data" | "power";
  /** DUPLEX : une connexion consomme une paire Tx/Rx (2 brins). Défaut false. Ex. LC duplex. */
  duplex?: boolean;
}
export interface CableTypeDef {
  id: string; name: string; family: string; medium: string; kind: "data" | "power";
}

export const DEFAULT_PORT_TYPES: PortTypeDef[] = [
  // ---- Ethernet cuivre (RJ45) ----
  { id: "pt-eth-100m-rj45", name: "100M RJ45",  family: "RJ45",   connector: "RJ45",     speed: "100M", kind: "data" },
  { id: "pt-eth-1g-rj45",   name: "1G RJ45",    family: "RJ45",   connector: "RJ45",     speed: "1G",   kind: "data" },
  { id: "pt-eth-2g5-rj45",  name: "2.5G RJ45",  family: "RJ45",   connector: "RJ45",     speed: "2.5G", kind: "data" },
  { id: "pt-eth-5g-rj45",   name: "5G RJ45",    family: "RJ45",   connector: "RJ45",     speed: "5G",   kind: "data" },
  { id: "pt-eth-10g-rj45",  name: "10G RJ45",   family: "RJ45",   connector: "RJ45",     speed: "10G",  kind: "data" },
  // ---- SFP (1 voie) ----
  { id: "pt-sfp-1g",        name: "1G SFP",     family: "SFP",    connector: "SFP",      speed: "1G",   kind: "data" },
  { id: "pt-sfpp-10g",      name: "10G SFP+",   family: "SFP+",   connector: "SFP+",     speed: "10G",  kind: "data" },
  { id: "pt-sfp28-25g",     name: "25G SFP28",  family: "SFP28",  connector: "SFP28",    speed: "25G",  kind: "data" },
  { id: "pt-sfp56-50g",     name: "50G SFP56",  family: "SFP56",  connector: "SFP56",    speed: "50G",  kind: "data" },
  // ---- QSFP (4-8 voies) ----
  { id: "pt-qsfpp-40g",     name: "40G QSFP+",  family: "QSFP+",  connector: "QSFP+",    speed: "40G",  kind: "data" },
  { id: "pt-qsfp28-100g",   name: "100G QSFP28",family: "QSFP28", connector: "QSFP28",   speed: "100G", kind: "data" },
  { id: "pt-qsfp56-200g",   name: "200G QSFP56",family: "QSFP56", connector: "QSFP56",   speed: "200G", kind: "data" },
  { id: "pt-qsfpdd-400g",   name: "400G QSFP-DD",family:"QSFP-DD",connector: "QSFP-DD",  speed: "400G", kind: "data" },
  { id: "pt-osfp-400g",     name: "400G OSFP",  family: "OSFP",   connector: "OSFP",     speed: "400G", kind: "data" },
  // ---- Fibre (connecteurs directs ; même famille ⇒ LC↔SC↔ST raccordables) ----
  { id: "pt-fo-mm-lc",      name: "Fibre MM (LC)", family: "FO-MM",  connector: "LC",    speed: "", kind: "data", duplex: true },
  { id: "pt-fo-mm-sc",      name: "Fibre MM (SC)", family: "FO-MM",  connector: "SC",    speed: "", kind: "data" },
  { id: "pt-fo-mm-st",      name: "Fibre MM (ST)", family: "FO-MM",  connector: "ST",    speed: "", kind: "data" },
  { id: "pt-fo-sm-lc",      name: "Fibre SM (LC)", family: "FO-SM",  connector: "LC",    speed: "", kind: "data", duplex: true },
  { id: "pt-fo-mpo",        name: "Fibre MPO/MTP", family: "FO-MPO", connector: "MPO",   speed: "", kind: "data" },
  // ---- Fibre Channel ----
  { id: "pt-fc-8g",         name: "FC 8G",      family: "FC",     connector: "SFP+",     speed: "8G",  kind: "data" },
  { id: "pt-fc-16g",        name: "FC 16G",     family: "FC",     connector: "SFP+",     speed: "16G", kind: "data" },
  { id: "pt-fc-32g",        name: "FC 32G",     family: "FC",     connector: "SFP28",    speed: "32G", kind: "data" },
  // ---- SAS ----
  { id: "pt-sas-6g",        name: "SAS 6G",     family: "SAS",    connector: "SFF-8644", speed: "6G",  kind: "data" },
  { id: "pt-sas-12g",       name: "SAS 12G",    family: "SAS",    connector: "SFF-8644", speed: "12G", kind: "data" },
  // ---- USB / console / vidéo ----
  { id: "pt-usb-a",         name: "USB-A",      family: "USB",    connector: "USB-A",    speed: "", kind: "data" },
  { id: "pt-usb-b",         name: "USB-B",      family: "USB",    connector: "USB-B",    speed: "", kind: "data" },
  { id: "pt-usb-c",         name: "USB-C",      family: "USB",    connector: "USB-C",    speed: "", kind: "data" },
  { id: "pt-console-rj45",  name: "Console RJ45",family: "SERIAL", connector: "RJ45",    speed: "", kind: "data" },
  { id: "pt-serial-db9",    name: "Série DB9",  family: "SERIAL", connector: "DB9",      speed: "", kind: "data" },
  { id: "pt-hdmi",          name: "HDMI",       family: "HDMI",   connector: "HDMI",     speed: "", kind: "data" },
  { id: "pt-dp",            name: "DisplayPort",family: "DP",     connector: "DP",       speed: "", kind: "data" },
  { id: "pt-vga",           name: "VGA",        family: "VGA",    connector: "VGA",      speed: "", kind: "data" },
  // ---- ALIMENTATION (kind power) ----
  { id: "pt-iec-c13",     name: "Prise C13 (PDU)",        family: "IEC-C13C14",   connector: "C13",      speed: "", kind: "power" },
  { id: "pt-iec-c14",     name: "Entrée C14 (PSU)",       family: "IEC-C13C14",   connector: "C14",      speed: "", kind: "power" },
  { id: "pt-iec-c19",     name: "Prise C19 (PDU)",        family: "IEC-C19C20",   connector: "C19",      speed: "", kind: "power" },
  { id: "pt-iec-c20",     name: "Entrée C20",             family: "IEC-C19C20",   connector: "C20",      speed: "", kind: "power" },
  { id: "pt-ac-schuko-f", name: "Prise Schuko (CEE 7/3)", family: "AC-SCHUKO",    connector: "CEE7/3",   speed: "", kind: "power" },
  { id: "pt-ac-schuko-m", name: "Fiche Schuko (CEE 7/4)", family: "AC-SCHUKO",    connector: "CEE7/4",   speed: "", kind: "power" },
  { id: "pt-cee-16a",     name: "IEC 60309 16A (CEE)",    family: "IEC60309-16A", connector: "CEE-16A",  speed: "", kind: "power" },
  { id: "pt-cee-32a",     name: "IEC 60309 32A (CEE)",    family: "IEC60309-32A", connector: "CEE-32A",  speed: "", kind: "power" },
  { id: "pt-ac-uk",       name: "Prise UK (BS1363)",      family: "AC-UK",        connector: "BS1363",   speed: "", kind: "power" },
  { id: "pt-ac-nema515",  name: "Prise NEMA 5-15 (US)",   family: "AC-NEMA515",   connector: "NEMA5-15", speed: "", kind: "power" },
  { id: "pt-raw-3W-25-20A", name: "Terminal 3Brins 2.5mm2 20A",     family: "RawElectrical",   connector: "Power Terminal", speed: "", kind: "power" },
  { id: "pt-raw-3W-16-16A", name: "Terminal 3Brins 1.5mm2 16A",     family: "RawElectrical",   connector: "Power Terminal", speed: "", kind: "power" }
];

export const DEFAULT_CABLE_TYPES: CableTypeDef[] = [
  // ---- Data ----
  { id: "ct-dac-sfpp",     name: "DAC SFP+",             family: "SFP+",    medium: "DAC cuivre",       kind: "data" },
  { id: "ct-aoc-sfpp",     name: "AOC SFP+",             family: "SFP+",    medium: "AOC",              kind: "data" },
  { id: "ct-fo-sfpp-mm",   name: "Fibre SFP+ Multimode", family: "SFP+",    medium: "Fibre multimode",  kind: "data" },
  { id: "ct-fo-sfpp-sm",   name: "Fibre SFP+ Monomode",  family: "SFP+",    medium: "Fibre monomode",   kind: "data" },
  { id: "ct-dac-sfp28",    name: "DAC SFP28",            family: "SFP28",   medium: "DAC cuivre",       kind: "data" },
  { id: "ct-dac-qsfpp",    name: "DAC QSFP+",            family: "QSFP+",   medium: "DAC cuivre",       kind: "data" },
  { id: "ct-breakout-q4s", name: "Breakout QSFP+→4×SFP+",family: "SFP+",    medium: "DAC/AOC breakout", kind: "data" },
  { id: "ct-dac-qsfp28",   name: "DAC QSFP28",           family: "QSFP28",  medium: "DAC cuivre",       kind: "data" },
  { id: "ct-aoc-qsfp28",   name: "AOC QSFP28",           family: "QSFP28",  medium: "AOC",              kind: "data" },
  { id: "ct-dac-qsfpdd",   name: "DAC QSFP-DD",          family: "QSFP-DD", medium: "DAC cuivre",       kind: "data" },
  { id: "ct-sas-8644",     name: "Câble SAS (SFF-8644)", family: "SAS",     medium: "Cuivre",           kind: "data" },
  { id: "ct-fo-fc",        name: "Fibre FC OM3",         family: "FC",      medium: "Fibre multimode",  kind: "data" },
  { id: "ct-fo-mm",        name: "Jarretière fibre MM",  family: "FO-MM",   medium: "Fibre multimode",  kind: "data" },
  { id: "ct-fo-sm",        name: "Jarretière fibre SM",  family: "FO-SM",   medium: "Fibre monomode",   kind: "data" },
  { id: "ct-fo-mpo",       name: "Trunk MPO/MTP",        family: "FO-MPO",  medium: "Fibre multimode",  kind: "data" },
  { id: "ct-rj45-cat6",    name: "RJ45 Cat6",            family: "RJ45",    medium: "Cuivre",           kind: "data" },
  { id: "ct-usb",          name: "Câble USB",            family: "USB",     medium: "USB",              kind: "data" },
  { id: "ct-hdmi",         name: "Câble HDMI",           family: "HDMI",    medium: "HDMI",             kind: "data" },
  { id: "ct-dp",           name: "Câble DisplayPort",    family: "DP",      medium: "DisplayPort",      kind: "data" },
  // ---- Alimentation ----
  { id: "ct-cord-c13c14",  name: "Cordon C13/C14",       family: "IEC-C13C14",   medium: "Cordon secteur", kind: "power" },
  { id: "ct-cord-c19c20",  name: "Cordon C19/C20",       family: "IEC-C19C20",   medium: "Cordon secteur", kind: "power" },
  { id: "ct-cord-schuko",  name: "Cordon Schuko (CEE 7)",family: "AC-SCHUKO",    medium: "Cordon secteur", kind: "power" },
  { id: "ct-cord-cee16",   name: "Cordon IEC 60309 16A", family: "IEC60309-16A", medium: "Cordon secteur", kind: "power" },
  { id: "ct-cord-cee32",   name: "Cordon IEC 60309 32A", family: "IEC60309-32A", medium: "Cordon secteur", kind: "power" },
  { id: "ct-cord-uk",      name: "Cordon UK (BS1363)",   family: "AC-UK",        medium: "Cordon secteur", kind: "power" },
  { id: "ct-cord-nema515", name: "Cordon NEMA 5-15",     family: "AC-NEMA515",   medium: "Cordon secteur", kind: "power" },
  { id: "ct-cable-raw-3W-25-20A", name: "Cable 3 Brins 2.5mm2 20A",     family: "RawElectrical",   medium: "Cordon secteur", kind: "power" },
  { id: "ct-cable-raw-3W-16-20A", name: "Cable 3 Brins 1.5mm2 16A",     family: "RawElectrical",   medium: "Cordon secteur", kind: "power" }
];
