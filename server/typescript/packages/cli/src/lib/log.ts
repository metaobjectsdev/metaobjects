export const log = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.error(`meta: ${msg}`),
  error: (msg: string) => console.error(`meta: ${msg}`),
};
