/** Mac の事業タグ・優待要約定時処理。ローカル .env だけを設定元にする。 */
export const biztagLocalEnv = {
  competitorPrepareCodes(): string[] | undefined {
    const value = process.env.BIZTAG_COMPETITOR_PREPARE_CODES;
    if (value === undefined) return undefined;
    if (value.trim() === "") throw new Error("BIZTAG_COMPETITOR_PREPARE_CODES は空文字にできません。未配備ならキーを除去してください。");
    return value.split(","); // 形式/重複/scope固定はstageの通信前検査で拒否する。
  },
  acceptedRevision(): string {
    const value = process.env.BIZTAG_LOCAL_ACCEPTED_REVISION;
    if (value === undefined || !/^[0-9a-f]{40}$/.test(value)) {
      throw new Error("BIZTAG_LOCAL_ACCEPTED_REVISION に承認済み main の40桁SHAが必要です。");
    }
    return value;
  },
};
