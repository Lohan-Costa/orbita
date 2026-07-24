import { useEffect, useState } from "react";
import { checkForUpdate, type UpdateStatus } from "../lib/updateCheck";
import { APP_VERSION } from "../lib/version";

/** Roda uma vez por abertura do app. `null` = "ainda checando" — a UI trata
 *  isso igual a "em dia" (sem aviso) até a resposta chegar. */
export function useUpdateCheck(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate(APP_VERSION).then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
