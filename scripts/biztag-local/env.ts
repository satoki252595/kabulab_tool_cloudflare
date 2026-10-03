/** Mac の事業タグ・優待要約定時処理。ローカル .env だけを設定元にする。 */
export const biztagLocalEnv = {
  acceptedRevision(): string {
    const value = process.env.BIZTAG_LOCAL_ACCEPTED_REVISION;
    if (value === undefined || !/^[0-9a-f]{40}$/.test(value)) {
      throw new Error("BIZTAG_LOCAL_ACCEPTED_REVISION に承認済み main の40桁SHAが必要です。");
    }
    return value;
  },
};
