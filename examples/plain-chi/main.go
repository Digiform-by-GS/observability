// Deliberately uninstrumented: no observability module, log.Printf logging,
// bare chi router. This is the "before" state the onboard skill transforms.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

type order struct {
	ID        string    `json:"id"`
	Items     []string  `json:"items"`
	CreatedAt time.Time `json:"createdAt"`
}

var orders = map[string]order{}

func main() {
	r := chi.NewRouter()

	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	r.Get("/orders/{id}", func(w http.ResponseWriter, req *http.Request) {
		id := chi.URLParam(req, "id")
		o, ok := orders[id]
		if !ok {
			log.Printf("order %s not found", id)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(o)
	})

	r.Post("/orders", func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			Items []string `json:"items"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		o := order{ID: strconv.FormatInt(time.Now().UnixNano(), 10), Items: body.Items, CreatedAt: time.Now()}
		orders[o.ID] = o
		log.Printf("order %s created with %d items", o.ID, len(o.Items))
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(o)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8096"
	}
	log.Printf("plain-chi listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, r))
}
