import type { RawInputRow, RtaAdapter, TargetCompany } from "../types.js";

export const LINK_INTIME_COMPANIES: TargetCompany[] = [
  {
    name: "Tata Motors Limited",
    cin: "L28920MH1945PLC004520",
    isin: "INE155A01022",
    nseSymbol: "TATAMOTORS",
    bseCode: "500570",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=TATAMOTORS",
  },
  {
    name: "Tata Steel Limited",
    cin: "L27100MH1907PLC000260",
    isin: "INE081A01020",
    nseSymbol: "TATASTEEL",
    bseCode: "500470",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=TATASTEEL",
  },
  {
    name: "Tata Consultancy Services Limited",
    cin: "L22210MH1995PLC084781",
    isin: "INE467B01029",
    nseSymbol: "TCS",
    bseCode: "532540",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=TCS",
  },
  {
    name: "ACC Limited",
    cin: "L26940MH1936PLC002515",
    isin: "INE012A01025",
    nseSymbol: "ACC",
    bseCode: "500410",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=ACC",
  },
  {
    name: "Ambuja Cements Limited",
    cin: "L26942GJ1981PLC004717",
    isin: "INE079A01024",
    nseSymbol: "AMBUJACEM",
    bseCode: "500425",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=AMBUJACEM",
  },
  {
    name: "UltraTech Cement Limited",
    cin: "L26940MH2000PLC128420",
    isin: "INE481G01011",
    nseSymbol: "ULTRACEMCO",
    bseCode: "532538",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=ULTRACEMCO",
  },
  {
    name: "Lupin Limited",
    cin: "L24100MH1983PLC029442",
    isin: "INE326A01037",
    nseSymbol: "LUPIN",
    bseCode: "500257",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=LUPIN",
  },
  {
    name: "Sun Pharmaceutical Industries Limited",
    cin: "L24230GJ1993PLC019050",
    isin: "INE044A01036",
    nseSymbol: "SUNPHARMA",
    bseCode: "524715",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=SUNPHARMA",
  },
  {
    name: "Godrej Consumer Products Limited",
    cin: "L51900MH2000PLC126427",
    isin: "INE102D01028",
    nseSymbol: "GODREJCP",
    bseCode: "532424",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=GODREJCP",
  },
  {
    name: "Asian Paints Limited",
    cin: "L24220MH1945PLC004598",
    isin: "INE021A01026",
    nseSymbol: "ASIANPAINT",
    bseCode: "500820",
    rta: "LINK_INTIME",
    iepfRegistryUrl: "https://web.linkintime.co.in/IEPF/UnclaimedDividends.aspx?cid=ASIANPAINT",
  },
];

const SAMPLE_NAMES = [
  "Naveen Chandra", "Harishankar Trivedi", "Siddharth Sen", "Vandana Kulkarni", "Mohanlal Soni",
  "Radheshyam Tiwari", "Anuradha Mukherjee", "Devendra Singhal", "Padmavathi Venkat", "Subramanian Swamy",
  "Chandrakant Parekh", "Shobha Deshpande", "Gopalakrishnan Nair", "Bhanumati Bhatt", "Manmohan Singh",
  "Tarun Kanti Ghosh", "Urmila Devi", "Dhananjay Gokhale", "Hemant Kapadia", "Sarojini Naidu"
];

const SAMPLE_LOCATIONS = [
  { city: "Mumbai", state: "Maharashtra", pin: "400050" },
  { city: "Surat", state: "Gujarat", pin: "395001" },
  { city: "Jaipur", state: "Rajasthan", pin: "302001" },
  { city: "Vadodara", state: "Gujarat", pin: "390001" },
  { city: "Nagpur", state: "Maharashtra", pin: "440001" },
  { city: "Indore", state: "Madhya Pradesh", pin: "452001" },
  { city: "Kanpur", state: "Uttar Pradesh", pin: "208001" },
  { city: "Coimbatore", state: "Tamil Nadu", pin: "641001" },
];

export class LinkIntimeAdapter implements RtaAdapter {
  readonly id = "link_intime";
  readonly displayName = "Link Intime (MUFG Link Intime) IEPF Registry";
  readonly rtaType = "LINK_INTIME" as const;

  async discover(options?: { limit?: number; companyQuery?: string }): Promise<TargetCompany[]> {
    let list = [...LINK_INTIME_COMPANIES];
    if (options?.companyQuery) {
      const q = options.companyQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.cin?.toLowerCase().includes(q) ||
          c.nseSymbol?.toLowerCase().includes(q),
      );
    }
    if (options?.limit && options.limit > 0) {
      list = list.slice(0, options.limit);
    }
    return list;
  }

  getSampleFiles(): Array<{
    company: TargetCompany;
    filePath?: string;
    generateRows?: (count: number) => RawInputRow[];
  }> {
    return LINK_INTIME_COMPANIES.map((company) => ({
      company,
      generateRows: (count: number) => this.generateSampleRows(company, count),
    }));
  }

  /**
   * Generates synthetic Link Intime Excel rows matching Link Intime spreadsheet conventions
   */
  generateSampleRows(company: TargetCompany, count: number): RawInputRow[] {
    const rows: RawInputRow[] = [];
    const prefix = company.nseSymbol ? company.nseSymbol.slice(0, 4) : "LINK";

    for (let i = 1; i <= count; i++) {
      const name = SAMPLE_NAMES[i % SAMPLE_NAMES.length]!;
      const loc = SAMPLE_LOCATIONS[i % SAMPLE_LOCATIONS.length]!;
      const folio = `${prefix}${String(200000 + i).padStart(8, "0")}`;
      const amount = (250.0 + (i * 49.5) % 9900).toFixed(2);
      const shares = (15 + (i * 5) % 300);

      rows.push({
        "FOLIO NO": folio,
        "SHAREHOLDER NAME": name,
        "FATHER / HUSBAND NAME": `Late ${name.split(" ")[1] ?? "Sharma"} Elder`,
        "ADDRESS LINE 1": `Flat ${i % 50}, Sterling Tower, MG Road`,
        "DISTRICT": loc.city,
        "STATE": loc.state,
        "PINCODE": loc.pin,
        "UNCLAIMED AMOUNT": amount,
        "DUE DATE OF TRANSFER": `2024-10-${String((i % 28) + 1).padStart(2, "0")}`,
        "NUMBER OF SHARES": String(shares),
      });
    }

    return rows;
  }
}
