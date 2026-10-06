import type {
  AnalysisQueueStats,
  CatalogStats,
  ConfirmPersonResult,
  FaceEmbeddingSet,
  MergePersonsResult,
  PersonCorrectionResult,
  PersonCandidate,
  PersonClusterInput,
  PersonOverview,
  PersonRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

const ALGORITHM_VERSION = "person-centroid-v1";

type ClusterWorkerResult = {
  algorithm: string;
  clusterThreshold: number;
  verificationThreshold: number;
  clusterCount: number;
  clusters: PersonClusterInput[];
};

type ReplacePersonCandidatesResult = {
  writtenClusters: number;
  writtenFaces: number;
};

export class PersonService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService
  ) {}

  async getOverview(
    sourceId: number,
    forceRefresh = false,
    allowWhilePending = false
  ): Promise<PersonOverview> {
    const queue = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      {
        sourceId,
        module: "face-embed-sface-v1"
      }
    );

    const clusteringPending = queue.pending > 0 || queue.running > 0;

    if (
      (!clusteringPending || allowWhilePending) &&
      this.analysis.getStatus().state === "READY"
    ) {
      const set = await this.catalog.request<FaceEmbeddingSet>(
        "getFaceEmbeddingsForClustering",
        {
          sourceId,
          algorithmVersion: ALGORITHM_VERSION
        }
      );

      if (forceRefresh || set.needsRebuild) {
        const clustered = await this.analysis.request<ClusterWorkerResult>(
          "cluster_face_embeddings",
          {
            faces: set.faces,
            cannotLinks: set.cannotLinks,
            clusterThreshold: 0.50,
            verificationThreshold: 0.363
          },
          120000
        );

        const replaced =
          await this.catalog.request<ReplacePersonCandidatesResult>(
            "replacePersonCandidates",
            {
              sourceId,
              revision: set.revision,
              algorithmVersion: ALGORITHM_VERSION,
              clusters: clustered.clusters
            }
          );

        this.analysis.logDiagnostic("IDENTITY_CLUSTER_RESULT", {
          identity: "people",
          sourceId,
          inputEmbeddings: set.faces.length,
          workerClusters: clustered.clusterCount,
          writtenClusters: replaced.writtenClusters,
          writtenItems: replaced.writtenFaces
        });

        if (replaced.writtenFaces !== set.faces.length) {
          throw new Error(
            "Personengruppierung hat " +
            set.faces.length +
            " gültige Gesichtsmerkmale erhalten, aber nur " +
            replaced.writtenFaces +
            " Gesichter in Kandidaten gespeichert."
          );
        }
      }
    }

    const [candidates, persons, stats] = await Promise.all([
      this.catalog.request<PersonCandidate[]>("listPersonCandidates", {
        sourceId,
        // Neue Gruppen müssen bei großen Katalogen sichtbar bleiben. Die DB
        // liefert sie neueste-zuerst; 500 hält DOM/Payload trotzdem begrenzt.
        limit: 500
      }),
      this.catalog.request<PersonRecord[]>("listPersons", { sourceId }),
      this.catalog.request<CatalogStats>("getStats", { sourceId })
    ]);

    return {
      candidates,
      persons,
      clusteringPending,
      candidateTotal: stats.personCandidates,
      candidateFaceTotal: stats.personCandidateFaces
    };
  }

  async refreshAllSources(incremental = false): Promise<void> {
    const sources = await this.catalog.request<Array<{
      id: number;
      path: string;
      enabled: boolean;
    }>>("listSources");

    for (const source of sources) {
      if (!source.enabled) continue;
      await this.getOverview(source.id, incremental, incremental);
    }
  }

  async confirmCandidate(
    candidateId: number,
    name: string
  ): Promise<ConfirmPersonResult> {
    return this.catalog.request<ConfirmPersonResult>(
      "confirmPersonCandidate",
      { candidateId, name }
    );
  }

  async removeCandidateFace(
    candidateId: number,
    faceDetectionId: number
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "removeFaceFromPersonCandidate",
      { candidateId, faceDetectionId }
    );
  }

  async removePersonFace(
    personId: number,
    faceDetectionId: number
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "removeFaceFromPerson",
      { personId, faceDetectionId }
    );
  }

  async mergePersons(
    targetPersonId: number,
    sourcePersonId: number
  ): Promise<MergePersonsResult> {
    return this.catalog.request<MergePersonsResult>(
      "mergePersons",
      { targetPersonId, sourcePersonId }
    );
  }

  async renamePerson(
    personId: number,
    name: string
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "renamePerson",
      { personId, name }
    );
  }
}
