import type {
  AnalysisQueueStats,
  CatalogStats,
  ConfirmPetResult,
  IgnorePetResult,
  PetCandidate,
  PetClusterInput,
  PetCorrectionResult,
  DirectIdentityAssignmentResult,
  SplitPetCandidateResult,
  AssignPetSelectionResult,
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
    rebuildIfNeeded = true,
    candidateLimit = 500,
    includeSupporting = true
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
          600000
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

    const normalizedCandidateLimit = Math.max(
      1,
      Math.min(2000, Math.trunc(candidateLimit || 500))
    );
    const candidates = await this.catalog.request<PetCandidate[]>(
      "listPetCandidates",
      {
        sourceId,
        limit: normalizedCandidateLimit,
        ignoreDefiniteThreshold: CLUSTER_THRESHOLD,
        ignoreDoubtThreshold: VERIFICATION_THRESHOLD
      }
    );
    const [pets, stats, ungroupedPets] = await Promise.all([
      includeSupporting
        ? this.catalog.request<PetRecord[]>("listPets", { sourceId })
        : Promise.resolve([] as PetRecord[]),
      this.catalog.request<CatalogStats>("getStats", { sourceId }),
      includeSupporting
        ? this.catalog.request<PetOverview["ungroupedPets"]>(
            "listUngroupedPetDetections",
            { sourceId, limit: 1000 }
          )
        : Promise.resolve([] as PetOverview["ungroupedPets"])
    ]);

    return {
      candidates,
      pets,
      ungroupedPets,
      clusteringPending,
      candidateTotal: stats.petCandidates,
      candidateDetectionTotal: stats.petCandidateDetections,
      ungroupedDetectionTotal: Math.max(
        0,
        stats.unassignedDogEmbeddings - stats.petCandidateDetections
      )
    };
  }

  async getCombinedOverview(
    forceRefresh = false,
    candidateLimit = 500,
    candidateOffset = 0,
    includeSupporting = true
  ): Promise<PetOverview> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");
    const enabledSources = sources.filter((source) => source.enabled);

    const normalizedLimit = Math.max(
      1,
      Math.min(100, Math.trunc(candidateLimit || 10))
    );
    const normalizedOffset = Math.max(0, Math.trunc(candidateOffset || 0));
    const sourceWindow = Math.min(2000, normalizedOffset + normalizedLimit);

    const overviews: PetOverview[] = [];
    for (const source of enabledSources) {
      // Normales Öffnen ist read-only; nur explizites Aktualisieren oder ein
      // Algorithmuswechsel darf synchron neu gruppieren.
      overviews.push(
        await this.getOverview(
          source.id,
          forceRefresh,
          false,
          forceRefresh,
          sourceWindow,
          includeSupporting
        )
      );
    }

    const petMap = new Map<number, PetRecord>();
    for (const overview of overviews) {
      for (const pet of overview.pets) {
        const existing = petMap.get(pet.id);
        if (!existing) {
          petMap.set(pet.id, {
            ...pet,
            pets: [...pet.pets],
            videoHits: [...pet.videoHits]
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

        const knownVideoHits = new Set(
          existing.videoHits.map((hit) =>
            [hit.mediaId, hit.startMs, hit.endMs].join(":")
          )
        );
        for (const hit of pet.videoHits) {
          const key = [hit.mediaId, hit.startMs, hit.endMs].join(":");
          if (!knownVideoHits.has(key)) {
            existing.videoHits.push(hit);
            knownVideoHits.add(key);
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
      .slice(normalizedOffset, normalizedOffset + normalizedLimit);

    return {
      candidates,
      pets: [...petMap.values()].sort(
        (a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" })
      ),
      ungroupedPets: overviews
        .flatMap((overview) => overview.ungroupedPets)
        .sort((a, b) => b.petDetectionId - a.petDetectionId)
        .slice(0, 4000),
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

  async rejectDetectionSuggestion(
    petDetectionId: number,
    petId: number
  ): Promise<PetCorrectionResult> {
    return this.catalog.request<PetCorrectionResult>(
      "rejectPetDetectionSuggestion",
      { petDetectionId, petId }
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

  async splitCandidate(
    candidateId: number,
    petDetectionIds: number[]
  ): Promise<SplitPetCandidateResult> {
    return this.catalog.request<SplitPetCandidateResult>(
      "splitPetCandidate",
      { candidateId, petDetectionIds }
    );
  }

  async assignCandidateSelection(
    candidateId: number,
    petDetectionIds: number[],
    name: string
  ): Promise<AssignPetSelectionResult> {
    return this.catalog.request<AssignPetSelectionResult>(
      "assignPetCandidateSelection",
      { candidateId, petDetectionIds, name }
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

  async assignDetectionName(
    petDetectionId: number,
    name: string
  ): Promise<DirectIdentityAssignmentResult> {
    return this.catalog.request<DirectIdentityAssignmentResult>(
      "assignPetDetectionName",
      { petDetectionId, name }
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
