export type OnboardProfile = {
  company: string | null;
  url: string;
  owner: string | null;
  location: string | null;
  vertical: string | null;
  services: string | null;
  years_operating: string | null;
  review?: OnboardReview | null;
};

export type OnboardReview = {
  author: string;
  rating: number;
  text: string;
  when?: string | null;
};

export type OnboardState = {
  token: string | null;
  url: string;
  vertical: string;
  goals: string[];
  integrations: string[];
  profile: OnboardProfile | null;
  startedAt: number;
};

export type OnboardStepId =
  | 'url' | 'verti' | 'goals' | 'integ' | 'fleet' | 'brief' | 'done';

export const EMPTY_STATE: OnboardState = {
  token: null,
  url: '',
  vertical: 'roofing',
  goals: ['respond', 'book', 'nurture'],
  integrations: ['jobber', 'gcal', 'twilio'],
  profile: null,
  startedAt: 0,
};
