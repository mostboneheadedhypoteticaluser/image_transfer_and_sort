import type {
  AnalysisQueueStats,
  ConfirmPetResult,
  PetCandidate,
  PetClusterInput,
  PetCorrectionResult,
  PetEmbeddingSet,
  MergePetsResult,
  PetOverview,
  PetRecord,
  SourceRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

const ALGORITHM_VERSION = "dogreid-centroid-v1";

type ClusterWorkerResult = {
  algorithm: string;
  clusterThreshold: number;
  verificationThreshold: number;
  minClusterSize: number;
  clusterCount: number;
  clusters: PetClusterInput[];
};

export class PetService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService
  ) {}

  async getOverview(
    sourceId: number,
    forceRefresh = false
  ): Promise<PetOverview> {
    const queue = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      {
        sourceId,
        module: "pet-embed-dogreid-v1"
      }
    );

    const clusteringPending = queue.pending > 0 || queue.running > 0;

    if (!clusteringPending && this.analysis.getStatus().state === "READY") {
      const set = await this.catalog.request<PetEmbeddingSet>(
        "getPetEmbeddingsForClustering",
        {
          sourceId,
          algorithmVersion: ALGORITHM_VERSION
        }
      );

      if (forceRefresh || set.needsRebuild) {
        const clustered = await this.analysis.request<ClusterWorkerResult>(
          "cluster_pet_embeddings",
          {
            pets: set.pets,
            cannotLinks: set.cannotLinks,
            clusterThreshold: 0.68,
            verificationThreshold: 0.60,
            minClusterSize: 2
          },
          120000
        );

        await this.catalog.request("replacePetCandidates", {
          sourceId,
          revision: set.revision,
          algorithmVersion: ALGORITHM_VERSION,
          clusters: clustered.clusters
        });
      }
    }

    const [candidates, pets] = await Promise.all([
      this.catalog.request<PetCandidate[]>("listPetCandidates", {
        sourceId,
        limit: 100
      }),
      this.catalog.request<PetRecord[]>("listPets", { sourceId })
    ]);

    return {
      candidates,
      pets,
      clusteringPending
    };
  }

  async refreshAllSources(): Promise<void> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");

    for (const source of sources) {
      if (!source.enabled) continue;
      await this.getOverview(source.id);
    }
  }

  async confirmCandidate(
    candidateId: number,
    name: string
  ): Promise<ConfirmPetResult> {
    return this.catalog.request<ConfirmPetResult>(
      "confirmPetCandidate",
      { candidateId, name }
    );
  }

  async removeCandidatePet(
    candidateId: number,
    petDetectionId: number
  ): Promise<PetCorrectionResult> {
    return this.catalog.request<PetCorrectionResult>(
      "removePetFromCandidate",
      { candidateId, petDetectionId }
    );
  }

  async removePetDetection(
    petId: number,
    petDetectionId: number
  ): Promise<PetCorrectionResult> {
    return this.catalog.request<PetCorrectionResult>(
      "removePetFromPet",
      { petId, petDetectionId }
    );
  }

  async mergePets(
    targetPetId: number,
    sourcePetId: number
  ): Promise<MergePetsResult> {
    return this.catalog.request<MergePetsResult>(
      "mergePets",
      { targetPetId, sourcePetId }
    );
  }

  async renamePet(
    petId: number,
    name: string
  ): Promise<PetCorrectionResult> {
    return this.catalog.request<PetCorrectionResult>(
      "renamePet",
      { petId, name }
    );
  }

}
