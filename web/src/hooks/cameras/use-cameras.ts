import { useEffect, useState } from 'react';

import { nvrClient } from '@/api/rest/nvr-client';
import type { Camera } from '@/types/camera';

export const useCameras = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = async () => {
    setIsLoading(true);
    try {
      setCameras(await nvrClient.discoverCameras());
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    nvrClient.discoverCameras().then((discoveredCameras) => {
      setCameras(discoveredCameras);
      setIsLoading(false);
    });
  }, []);
  return { cameras, isLoading, refresh };
};
