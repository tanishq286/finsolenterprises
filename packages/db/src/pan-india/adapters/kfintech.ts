import type { RawInputRow, RtaAdapter, TargetCompany } from "../types.js";

export const KFINTECH_COMPANIES: TargetCompany[] = [
  {
    name: "Infosys Limited",
    cin: "L85110KA1981PLC013115",
    isin: "INE009A01021",
    nseSymbol: "INFY",
    bseCode: "500209",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=INFY",
  },
  {
    name: "Hindustan Unilever Limited",
    cin: "L15140MH1933PLC002030",
    isin: "INE030A01027",
    nseSymbol: "HINDUNILVR",
    bseCode: "500696",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=HUL",
  },
  {
    name: "Wipro Limited",
    cin: "L32102KA1945PLC020800",
    isin: "INE075A01022",
    nseSymbol: "WIPRO",
    bseCode: "507685",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=WIPRO",
  },
  {
    name: "Axis Bank Limited",
    cin: "L65110GJ1993PLC020769",
    isin: "INE238A01034",
    nseSymbol: "AXISBANK",
    bseCode: "532215",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=AXISBANK",
  },
  {
    name: "Dr. Reddy's Laboratories Limited",
    cin: "L85195TG1984PLC004507",
    isin: "INE089A01023",
    nseSymbol: "DRREDDY",
    bseCode: "500124",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=DRREDDY",
  },
  {
    name: "Cipla Limited",
    cin: "L24239MH1935PLC002380",
    isin: "INE059A01026",
    nseSymbol: "CIPLA",
    bseCode: "500087",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=CIPLA",
  },
  {
    name: "Bajaj Finance Limited",
    cin: "L65910MH1987PLC042961",
    isin: "INE296A01024",
    nseSymbol: "BAJFINANCE",
    bseCode: "500034",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=BAJFINANCE",
  },
  {
    name: "Marico Limited",
    cin: "L15140MH1988PLC049208",
    isin: "INE196A01026",
    nseSymbol: "MARICO",
    bseCode: "531642",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=MARICO",
  },
  {
    name: "Havells India Limited",
    cin: "L31900DL1983PLC016304",
    isin: "INE176B01034",
    nseSymbol: "HAVELLS",
    bseCode: "517354",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=HAVELLS",
  },
  {
    name: "Titan Company Limited",
    cin: "L74999TZ1984PLC001456",
    isin: "INE280A01028",
    nseSymbol: "TITAN",
    bseCode: "500114",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://ris.kfintech.com/investor/iepf/search.aspx?cid=TITAN",
  },
];

const SAMPLE_FIRST_NAMES = [
  "Ramesh", "Suresh", "Sunita", "Rajesh", "Pooja", "Vikram", "Anita", "Amit", "Meena", "Sanjay",
  "Prakash", "Kavita", "Deepak", "Asha", "Manoj", "Geeta", "Arun", "Neeta", "Kishore", "Rekha"
];

const SAMPLE_LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Gupta", "Mehta", "Shah", "Reddy", "Nair", "Iyer", "Rao",
  "Singh", "Kumar", "Joshi", "Bhat", "Deshmukh", "Kulkarni", "Agarwal", "Chopra", "Das", "Menon"
];

const SAMPLE_CITIES = [
  { city: "Bengaluru", state: "Karnataka", pin: "560001" },
  { city: "Mumbai", state: "Maharashtra", pin: "400001" },
  { city: "Hyderabad", state: "Telangana", pin: "500001" },
  { city: "Ahmedabad", state: "Gujarat", pin: "380001" },
  { city: "Chennai", state: "Tamil Nadu", pin: "600001" },
  { city: "Delhi", state: "Delhi", pin: "110001" },
  { city: "Pune", state: "Maharashtra", pin: "411001" },
  { city: "Kolkata", state: "West Bengal", pin: "700001" },
];

export class KFintechAdapter implements RtaAdapter {
  readonly id = "kfintech";
  readonly displayName = "KFintech IEPF Registry";
  readonly rtaType = "KFINTECH" as const;

  async discover(options?: { limit?: number; companyQuery?: string }): Promise<TargetCompany[]> {
    let list = [...KFINTECH_COMPANIES];
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
    return KFINTECH_COMPANIES.map((company) => ({
      company,
      generateRows: (count: number) => this.generateSampleRows(company, count),
    }));
  }

  /**
   * Generates synthetic KFintech Form IEPF-2 rows matching standard KFintech registry export headers
   */
  generateSampleRows(company: TargetCompany, count: number): RawInputRow[] {
    const rows: RawInputRow[] = [];
    const prefix = company.nseSymbol ?? "KFIN";

    for (let i = 1; i <= count; i++) {
      const firstName = SAMPLE_FIRST_NAMES[i % SAMPLE_FIRST_NAMES.length]!;
      const lastName = SAMPLE_LAST_NAMES[i % SAMPLE_LAST_NAMES.length]!;
      const loc = SAMPLE_CITIES[i % SAMPLE_CITIES.length]!;
      const folio = `${prefix}${String(100000 + i).padStart(8, "0")}`;
      const amount = (120.5 + (i * 37.25) % 8500).toFixed(2);
      const shares = (10 + (i * 7) % 250);

      rows.push({
        "Investor First Name": firstName,
        "Investor Middle Name": i % 3 === 0 ? "Kumar" : "",
        "Investor Last Name": lastName,
        "Father / Husband First Name": `${SAMPLE_FIRST_NAMES[(i + 5) % SAMPLE_FIRST_NAMES.length]} ${lastName}`,
        "Address": `${100 + (i % 899)}, Commercial Enclave, 2nd Cross, Industrial Area`,
        "City": loc.city,
        "State": loc.state,
        "Pin Code": loc.pin,
        "Folio Number / DP ID Client ID": folio,
        "Investment Type": "Amount for unclaimed and unpaid dividend",
        "Amount Transferred": amount,
        "Proposed Date of Transfer to IEPF": `2024-11-${String((i % 28) + 1).padStart(2, "0")}`,
        "Number of Shares": String(shares),
      });
    }

    return rows;
  }
}
