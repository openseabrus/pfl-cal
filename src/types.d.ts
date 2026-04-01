type PFLEvent = {
  name: string;
  url: URL;
  date: string;
  timezone: string;
  location: string;
  fightCard: string[];
  mainCard: string[];
  prelims: string[];
  earlyPrelims: string[];
  prelimsTime: string | undefined;
  earlyPrelimsTime: string | undefined;
};
