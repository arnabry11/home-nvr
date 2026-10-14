import { useEffect, useState } from "react";

import { nvrClient } from "@/api/rest/nvr-client";

export type NvrHealth = "checking" | "connected" | "disconnected";

export const useNvrHealth = () => {
  const [health, setHealth] = useState<NvrHealth>("checking");

  const refresh = async () => {
    setHealth("checking");
    try {
      await nvrClient.getHealth();
      setHealth("connected");
    } catch {
      setHealth("disconnected");
    }
  };

  useEffect(() => {
    const updateHealth = () => {
      nvrClient.getHealth().then(
        () => setHealth("connected"),
        () => setHealth("disconnected"),
      );
    };
    updateHealth();
    const intervalId = window.setInterval(updateHealth, 15_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return { health, refresh };
};
