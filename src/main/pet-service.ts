import type {
  AnalysisQueueStats,
  CatalogStats,
  ConfirmPetResult,
  IgnorePetResult,
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

const ALGORITHM_VERSION = "dogreid-complete-link-v4-ignore";
const CLUSTER_THRESHOLD = 0.68;
const VERIFICATION_THRESHOLD = 0.60;

type ClusterWorkerResult = {
  algorithm: string;
  clusterThreshold: number;
  verificationThreshold: number;
  minClusterSize: number;
  clusterCount: number;
  clusters: PetClusterInput[];
};

type ReplacePetCandidatesResult = {
  writtenClusters: number;
  writtenPets: number;
};

export class PetService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService
  ) {}

  async getOverview(
    sourceId: number,
    forceRefresh = false,
    allowWhilePending = false,
    rebuildIfNeeded = true
  ): Promise<PetOverview> {
    const queue = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      {
        sourceId,
        module: "pet-embed-dogreid-v1"
      }
    );

    const clusteringPending = queue.pending > 0 || queue.running > 0;

    if (
      (!clusteringPending || allowWhilePending) &&
      this.analysis.getStatus().state === "READY"
    ) {
      const set = await this.catalog.request<PetEmbeddingSet>(
        "getPetEmbeddingsForClustering",
        {
          sourceId,
          algorithmVersion: ALGORITHM_VERSION,
          ignoreDefiniteThreshold: CLUSTER_THRESHOLD,
          ignoreDoubtThreshold: VERIFICATION_THRESHOLD
        }
      );

      if (
        forceRefresh ||
        set.algorithmChanged ||
        (rebuildIfNeeded && set.needsRebuild)
      ) {
        const clustered = await this.analysis.request<ClusterWorkerResult>(
          "cluster_pet_embeddings",
          {
            pets: set.pets,
            cannotLinks: set.cannotLinks,
            clusterThreshold: CLUSTER_THRESHOLD,
            verificationThreshold: VERIFICATION_THRESHOLD,
            minClusterSize: 2
          },
          120000
        );

        const replaced =
          await this.catalog.request<ReplacePetCandidatesResult>(
            "replacePetCandidates",
            {
              sourceId,
              revision: set.revision,
              algorithmVersion: ALGORITHM_VERSION,
              clusters: clustered.clusters
            }
          );

        this.analysis.logDiagnostic("IDENTITY_CLUSTER_RESULT", {
          identity: "pets",
          sourceId,
          inputEmbeddings: set.pets.length,
          workerClusters: clustered.clusterCount,
          writtenClusters: replaced.writtenClusters,
          writtenItems: replaced.writtenPets,
          ungroupedItems: Math.max(0, set.pets.length - replaced.writtenPets)
        });

        const expectedGroupedPets = clustered.clusters.reduce(
          (sum, cluster) => sum + cluster.members.length,
          0
        );
        if (replaced.writtenPets !== expectedGroupedPets) {
          throw new Error(
            "Hundegruppierung wollte " +
            expectedGroupedPets +
            " Fundstellen in echten Gruppen speichern, aber " +
            replaced.writtenPets +
            " wurden geschrieben."
          );
        }
      }

      await this.catalog.request("autoAssignKnownPetCandidates", { sourceId });
    }

    const candidates = await this.catalog.request<PetCandidate[]>(
      "listPetCandidates",
      {
        sourceId,
        limit: 500,
        ignoreDefiniteThreshold: CLUSTER_THRESHOLD,
        ignoreDoubtThreshold: VERIFICATION_THRESHOLD
      }
    );
    const [pets, stats] = await Promise.all([
      this.catalog.request<PetRecord[]>("listPets", { sourceId }),
      this.catalog.request<CatalogStats>("getStats", { sourceId })
    ]);

    return {
      candidates,
      pets,
      clusteringPending,
      candidateTotal: stats.petCandidates,
      candidateDetectionTotal: stats.petCandidateDetections,
      ungroupedDetectionTotal: Math.max(
        0,
        stats.unassignedDogEmbeddings - stats.petCandidateDetections
      )
    };
  }

  async getCombinedOverview(forceRefresh = false): Promise<PetOverview> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");
    const enabledSources = sources.filter((source) => source.enabled);

    const overviews: PetOverview[] = [];
    for (const source of enabledSources) {
      // Normales Öffnen ist read-only; nur explizites Aktualisieren oder ein
      // Algorithmuswechsel darf synchron neu gruppieren.
      overviews.push(
        await this.getOverview(source.id, forceRefresh, false, forceRefresh)
      );
    }

    const petMap = new Map<number, PetRecord>();
    for (const overview of overviews) {
      for (const pet of overview.pets) {
        const existing = petMap.get(pet.id);
        if (!existing) {
          petMap.set(pet.id, {
            ...pet,
            pets: [...pet.pets]
          });
          continue;
        }

        existing.detectionCount += pet.detectionCount;
        existing.confirmedCount += pet.confirmedCount;
        existing.automaticCount += pet.automaticCount;
        if (existing.representativePetId === null) {
          existing.representativePetId = pet.representativePetId;
        }

        const knownDetectionIds = new Set(
          existing.pets.map((item) => item.petDetectionId)
        );
        for (const item of pet.pets) {
          if (!knownDetectionIds.has(item.petDetectionId)) {
            existing.pets.push(item);
            knownDetectionIds.add(item.petDetectionId);
          }
        }
      }
    }

    const candidates = overviews
      .flatMap((overview) => overview.candidates)
      .sort(
        (a, b) =>
          b.detectionCount - a.detectionCount ||
          b.averageSimilarity - a.averageSimilarity ||
          b.newestPetId - a.newestPetId
      )
      .slice(0, 500);

    return {
      candidates,
      pets: [...petMap.values()].sort(
        (a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" })
      ),
      clusteringPending: overviews.some((overview) => overview.clusteringPending),
      candidateTotal: overviews.reduce(
        (sum, overview) => sum + overview.candidateTotal,
        0
      ),
      candidateDetectionTotal: overviews.reduce(
        (sum, overview) => sum + overview.candidateDetectionTotal,
        0
      ),
      ungroupedDetectionTotal: overviews.reduce(
        (sum, overview) => sum + overview.ungroupedDetectionTotal,
        0
      )
    };
  }

  async refreshAllSources(incremental = false): Promise<void> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");

    for (const source of sources) {
      if (!source.enabled) continue;
      await this.getOverview(source.id, incremental, incremental);
    }
  }

  async confirmCandidate(
    candidateId: number,
    name: string,
    rejectedPetId?: number,
    fallbackPetDetectionId?: number,
    expectedDetectionCount?: number,
    expectedMemberSignature?: string
  ): Promise<ConfirmPetResult> {
    return this.catalog.request<ConfirmPetResult>(
      "confirmPetCandidate",
      {
        candidateId,
        name,
        rejectedPetId,
        fallbackPetDetectionId,
        expectedDetectionCount,
        expectedMemberSignature
      }
    );
  }

  async ignoreCandidate(
    candidateId: number,
    fallbackPetDetectionId?: number,
    expectedDetectionCount?: number,
    expectedMemberSignature?: string,
    ignoredIdentityId?: number
  ): Promise<IgnorePetResult> {
    return this.catalog.request<IgnorePetResult>(
      "ignorePetCandidate",
      {
        candidateId,
        fallbackPetDetectionId,
        expectedDetectionCount,
        expectedMemberSignature,
        ignoredIdentityId
      }
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

  async confirmPetDetection(
    petId: number,
    petDetectionId: number
  ): Promise<PetCorrectionResult> {
    return this.catalog.request<PetCorrectionResult>(
      "confirmPetDetection",
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
